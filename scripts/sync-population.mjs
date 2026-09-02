#!/usr/bin/env node
// Daily population-data sync for the static "島嶼人口觀測站" site.
//
// This is a straight Node.js port of the reference project's
// `source/app/api/population/route.ts` (`syncPopulationCache`). Instead of
// writing to a Cloudflare D1 shared cache, it writes the same JSON shape to
// `data/population.json` in this repo. A GitHub Actions workflow
// (.github/workflows/sync-population.yml) runs this once a day and commits
// the result — visitors' browsers only ever read that static file, they
// never call the government sources directly.
//
// Guard rule (ported from the spec): if the previous successful sync was
// less than 20 hours ago, do nothing. This protects the official sources
// from being hit more than once a day even if someone re-runs the workflow
// manually.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = resolve(root, 'data/population.json');
const FALLBACK_PATH = resolve(root, 'lib/population-fallback.json');

const RIS_API = 'https://www.ris.gov.tw/rs-opendata/api/v1/datastore/ODRP014';
const SCHEDULE_GUARD_MS = 20 * 60 * 60 * 1000;
const FORCE = process.argv.includes('--force');

async function main() {
  const previous = await readJsonSafe(DATA_PATH);

  if (previous?.syncedAt && !FORCE && Date.now() - previous.syncedAt < SCHEDULE_GUARD_MS) {
    console.log(`距離上次成功同步不到 20 小時（${new Date(previous.syncedAt).toISOString()}），略過本次同步。`);
    return;
  }

  try {
    const payload = await fetchFreshPopulation();
    payload.syncedAt = Date.now();
    payload.stale = false;
    delete payload.syncWarning;
    await writeFile(DATA_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log(`同步成功：${payload.latestMonth}（產製時間 ${payload.generatedAt}）`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`官方資料同步失敗：${message}`);

    const base = previous ?? { ...(await readJsonSafe(FALLBACK_PATH)), syncedAt: 0 };
    const next = {
      ...base,
      stale: true,
      syncWarning: previous
        ? `今日自動同步未完成，繼續顯示上次成功資料。${message}`
        : `每日同步排程尚未完成第一次更新，目前顯示建置時查證的官方資料快照。${message}`,
    };
    await writeFile(DATA_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');

    // Re-throw so the GitHub Actions run is marked failed and shows up in
    // notifications — the *data* still degrades gracefully (stale flag),
    // but a human should know the daily sync is broken.
    process.exitCode = 1;
  }
}

async function readJsonSafe(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function fetchFreshPopulation() {
  const latest = await findLatestAvailableMonth();
  const previousMonth = previousRocMonth(latest.month);
  const current = await aggregateMonth(latest.month, true, latest.firstPage);
  const previous = await aggregateMonth(previousMonth, false);
  const trend = await fetchTrend(latest.month);
  const latestTrend = trend.at(-1);

  if (!latestTrend) throw new Error('找不到最新出生死亡資料');

  const rankings = buildRankings(current.towns, previous.towns);
  return {
    latestMonth: rocToGregorianMonth(latest.month),
    latestRocMonth: latest.month,
    previousMonth: rocToGregorianMonth(previousMonth),
    generatedAt: new Date().toISOString(),
    stale: false,
    totals: {
      population: current.total,
      male: current.male,
      female: current.female,
      birth: latestTrend.birth,
      death: latestTrend.death,
      naturalChange: latestTrend.birth - latestTrend.death,
      monthlyChange: current.total - previous.total,
    },
    trend,
    pyramid: current.pyramid.map((value, index) => ({
      age: index === 20 ? '100歲以上' : `${index * 5}–${index * 5 + 4}歲`,
      male: value.male,
      female: value.female,
    })),
    topIncrease: rankings.increase,
    topDecrease: rankings.decrease,
    topRateIncrease: rankings.rateIncrease,
    topRateDecrease: rankings.rateDecrease,
    townChanges: rankings.items,
    rankingCoverage: rankings.coverage,
  };
}

async function findLatestAvailableMonth() {
  const taipeiNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  let year = taipeiNow.getUTCFullYear();
  let month = taipeiNow.getUTCMonth(); // 0-based -> already "previous" gregorian month

  if (month === 0) { year -= 1; month = 12; }

  for (let offset = 0; offset < 8; offset += 1) {
    const rocMonth = toRocMonth(year, month);
    const firstPage = await fetchApiPage(rocMonth, 1, false);
    if (firstPage.responseCode === 'OD-0101-S' && firstPage.responseData?.length) {
      return { month: rocMonth, firstPage };
    }
    month -= 1;
    if (month === 0) { year -= 1; month = 12; }
  }

  throw new Error('近八個月皆查無戶政資料');
}

async function aggregateMonth(rocMonth, includePyramid, knownFirstPage) {
  const aggregate = {
    total: 0,
    male: 0,
    female: 0,
    towns: new Map(),
    pyramid: Array.from({ length: 21 }, () => ({ male: 0, female: 0 })),
  };

  const firstPage = knownFirstPage ?? (await fetchApiPage(rocMonth, 1));
  if (firstPage.responseCode !== 'OD-0101-S' || !firstPage.responseData) {
    throw new Error(`${rocMonth} 戶籍人口資料不存在`);
  }

  accumulateRows(aggregate, firstPage.responseData, includePyramid);
  const totalPages = Number(firstPage.totalPage ?? 1);

  for (let page = 2; page <= totalPages; page += 1) {
    const payload = await fetchApiPage(rocMonth, page);
    if (!payload.responseData) throw new Error(`${rocMonth} 第 ${page} 頁資料不完整`);
    accumulateRows(aggregate, payload.responseData, includePyramid);
  }

  return aggregate;
}

function accumulateRows(aggregate, rows, includePyramid) {
  for (const row of rows) {
    const total = numeric(row.people_total);
    aggregate.total += total;
    aggregate.male += numeric(row.people_total_m);
    aggregate.female += numeric(row.people_total_f);

    if (row.site_id) {
      aggregate.towns.set(row.site_id, (aggregate.towns.get(row.site_id) ?? 0) + total);
    }

    if (!includePyramid) continue;

    for (let age = 0; age <= 99; age += 1) {
      const key = String(age).padStart(3, '0');
      const bucket = Math.floor(age / 5);
      aggregate.pyramid[bucket].male += numeric(row[`people_age_${key}_m`]);
      aggregate.pyramid[bucket].female += numeric(row[`people_age_${key}_f`]);
    }
    aggregate.pyramid[20].male += numeric(row.people_age_100up_m);
    aggregate.pyramid[20].female += numeric(row.people_age_100up_f);
  }
}

async function fetchApiPage(rocMonth, page, throwOnFailure = true) {
  const response = await fetchWithRetry(`${RIS_API}/${rocMonth}?page=${page}`);
  const payload = await response.json();
  if (throwOnFailure && payload.responseCode !== 'OD-0101-S') {
    throw new Error(payload.responseMessage || `${rocMonth} 查無資料`);
  }
  return payload;
}

async function fetchTrend(latestRocMonth) {
  const startYear = 83;
  const common = 'https://statis.moi.gov.tw/micst/webMain.aspx?sys=220&kind=21&type=1&cycle=41&outmode=12&utf=1&compmode=0&outkind=3&codspc0=0,2,3,2,6,1,9,1,12,1,15,16,';
  const range = `&ym=${String(startYear).padStart(3, '0')}01&ymt=${latestRocMonth}`;
  const birthUrl = `${common}&funid=c0120101&fldspc=0,7,${range}`;
  const deathUrl = `${common}&funid=c0120201&fldspc=0,5,${range}`;

  const [birthResponse, deathResponse] = await Promise.all([fetchWithRetry(birthUrl), fetchWithRetry(deathUrl)]);
  const [birthText, deathText] = await Promise.all([birthResponse.text(), deathResponse.text()]);
  const births = parseNationalMonthlySeries(birthText);
  const deaths = parseNationalMonthlySeries(deathText);

  return [...births.entries()]
    .filter(([period]) => deaths.has(period))
    .map(([period, birth]) => {
      const [year, month] = period.split('-').map(Number);
      return { period, year, month, birth, death: deaths.get(period) ?? 0 };
    })
    .sort((a, b) => a.period.localeCompare(b.period));
}

function parseNationalMonthlySeries(csv) {
  const result = new Map();
  for (const rawLine of csv.split(/\r?\n/)) {
    const fields = parseCsvLine(rawLine);
    const match = fields[0]?.match(/^(\d+)年\s+(\d+)月\/\s*區域別總計$/);
    if (!match) continue;
    const year = Number(match[1]) + 1911;
    const month = Number(match[2]);
    result.set(`${year}-${String(month).padStart(2, '0')}`, numeric(fields[1]));
  }
  return result;
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index += 1; }
      else { quoted = !quoted; }
    } else if (char === ',' && !quoted) {
      fields.push(current); current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function buildRankings(current, previous) {
  const comparable = [];
  for (const [name, currentPopulation] of current) {
    const previousPopulation = previous.get(name);
    if (previousPopulation === undefined || previousPopulation === 0) continue;
    const change = currentPopulation - previousPopulation;
    comparable.push({
      name,
      county: extractCounty(name),
      current: currentPopulation,
      previous: previousPopulation,
      change,
      rate: (change / previousPopulation) * 100,
    });
  }

  const increases = comparable.filter((item) => item.change > 0);
  const decreases = comparable.filter((item) => item.change < 0);

  return {
    items: comparable,
    increase: [...increases].sort((a, b) => b.change - a.change).slice(0, 10),
    decrease: [...decreases].sort((a, b) => a.change - b.change).slice(0, 10),
    rateIncrease: [...increases].sort((a, b) => b.rate - a.rate).slice(0, 10),
    rateDecrease: [...decreases].sort((a, b) => a.rate - b.rate).slice(0, 10),
    coverage: comparable.length,
  };
}

function extractCounty(siteName) {
  return siteName.match(/^(.+?[縣市])/)?.[1] ?? siteName;
}

async function fetchWithRetry(url) {
  let latestError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json,text/csv;q=0.9,*/*;q=0.8' }, redirect: 'follow' });
      if (response.ok) return response;
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(`官方來源回應 ${response.status}`);
      }
      latestError = new Error(`官方來源暫時回應 ${response.status}`);
    } catch (error) {
      latestError = error instanceof Error ? error : new Error('官方來源連線失敗');
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  throw latestError ?? new Error('官方來源連線失敗');
}

function numeric(value) {
  const parsed = Number(String(value ?? '0').replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toRocMonth(year, month) {
  return `${String(year - 1911).padStart(3, '0')}${String(month).padStart(2, '0')}`;
}

function previousRocMonth(rocMonth) {
  let year = Number(rocMonth.slice(0, 3)) + 1911;
  let month = Number(rocMonth.slice(3, 5)) - 1;
  if (month === 0) { year -= 1; month = 12; }
  return toRocMonth(year, month);
}

function rocToGregorianMonth(rocMonth) {
  const year = Number(rocMonth.slice(0, 3)) + 1911;
  return `${year}-${rocMonth.slice(3, 5)}`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
