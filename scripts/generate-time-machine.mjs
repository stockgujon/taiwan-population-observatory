#!/usr/bin/env node
// Regenerates data/population-time-machine.json from the NDC five-age-group
// population projection CSV. This is a straight port of the reference
// project's `source/scripts/generate-time-machine.mjs` — only the output
// path changed (public/data/... -> data/...). Run manually whenever the
// NDC publishes a new projection edition; it is NOT part of the daily
// GitHub Actions sync (the spec explicitly treats the time machine as
// static, slow-changing data, not a daily-refreshed feed).
//
// Usage: node scripts/generate-time-machine.mjs

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'data-sources/ndc-five-age-population-1992-2075.csv');
const outputPath = resolve(root, 'data/population-time-machine.json');
const sourceText = (await readFile(sourcePath, 'utf8')).replace(/^﻿/, '');
const lines = sourceText.split(/\r?\n/).filter(Boolean);
const yearHeaderIndex = lines.findIndex((line) => line.startsWith(',,,1992,'));

if (yearHeaderIndex < 0) throw new Error('找不到國發會 CSV 年份標題列');

const years = lines[yearHeaderIndex].split(',').slice(3).map(Number);
const scenarioNames = { high: '高推估', medium: '中推估', low: '低推估' };
const sexNames = { male: '男性', female: '女性' };
const sourceRows = lines
  .slice(yearHeaderIndex + 2)
  .map((line) => line.split(','))
  .filter((row) => Object.values(scenarioNames).includes(row[0])
    && Object.values(sexNames).includes(row[1])
    && row.length === years.length + 3);
const ageLabels = [...new Set(sourceRows.map((row) => row[2]))];

if (years.at(0) !== 1992 || years.at(-1) !== 2075) {
  throw new Error(`年份範圍不符：${years.at(0)}–${years.at(-1)}`);
}
if (ageLabels.length !== 21) throw new Error(`五齡組數量不符：${ageLabels.length}`);

const rowIndex = new Map(
  sourceRows.map((row) => [`${row[0]}|${row[1]}|${row[2]}`, row.slice(3).map(Number)]),
);

function snapshotFor(year, scenario) {
  const yearIndex = years.indexOf(year);
  const pyramid = ageLabels.map((age) => {
    const male = rowIndex.get(`${scenarioNames[scenario]}|${sexNames.male}|${age}`)?.[yearIndex];
    const female = rowIndex.get(`${scenarioNames[scenario]}|${sexNames.female}|${age}`)?.[yearIndex];
    if (!Number.isFinite(male) || !Number.isFinite(female)) {
      throw new Error(`缺少 ${year} ${scenario} ${age} 的男女資料`);
    }
    return { age: age.replace('-', '–'), male, female };
  });

  const sumRange = (start, end) =>
    pyramid.slice(start, end).reduce((total, item) => total + item.male + item.female, 0);
  const male = pyramid.reduce((total, item) => total + item.male, 0);
  const female = pyramid.reduce((total, item) => total + item.female, 0);
  const children = sumRange(0, 3);
  const working = sumRange(3, 13);
  const older = sumRange(13, pyramid.length);

  return {
    year,
    male,
    female,
    total: male + female,
    children,
    working,
    older,
    agingIndex: children > 0 ? Number(((older / children) * 100).toFixed(2)) : 0,
    pyramid,
  };
}

for (const year of years.filter((value) => value <= 2025)) {
  const high = snapshotFor(year, 'high');
  const medium = snapshotFor(year, 'medium');
  const low = snapshotFor(year, 'low');
  if (JSON.stringify(high.pyramid) !== JSON.stringify(medium.pyramid)
    || JSON.stringify(low.pyramid) !== JSON.stringify(medium.pyramid)) {
    throw new Error(`${year} 的歷史統計在三種情境中不一致`);
  }
}

const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  actualThrough: 2025,
  projectionFrom: 2026,
  projectionThrough: 2075,
  source: {
    label: '國家發展委員會「中華民國人口推估（2026年至2075年）」',
    url: 'https://pop-proj.ndc.gov.tw/Custom_Detail_Search.aspx?n=39&t=1',
    releaseDate: '2026-08-28',
    downloadedAt: new Date().toISOString(),
    indicator: '五齡人口數（年底人口）',
    license: '政府資料開放授權條款第1版',
  },
  actual: years.filter((year) => year <= 2025).map((year) => snapshotFor(year, 'medium')),
  projections: Object.fromEntries(
    Object.keys(scenarioNames).map((scenario) => [
      scenario,
      years.filter((year) => year >= 2026).map((year) => snapshotFor(year, scenario)),
    ]),
  ),
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(payload));
console.log(`已產生 ${outputPath}`);
console.log(`實際 ${payload.actual.length} 年；各情境推估 ${payload.projections.medium.length} 年`);
