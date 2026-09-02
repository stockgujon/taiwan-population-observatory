(() => {
  'use strict';

  const CACHE_KEY = 'taiwan-population-observatory:last-successful:v3';
  const number = new Intl.NumberFormat('zh-TW');
  const percent = new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const css = getComputedStyle(document.documentElement);
  const colorVar = (name) => css.getPropertyValue(name).trim() || undefined;
  const COLORS = {
    birth: colorVar('--birth'),
    death: colorVar('--death'),
    male: colorVar('--male'),
    female: colorVar('--female'),
    primary: colorVar('--primary'),
    projHigh: colorVar('--projection-high'),
    projMedium: colorVar('--projection-medium'),
    projLow: colorVar('--projection-low'),
    borderStrong: colorVar('--border-strong'),
  };

  // ---------- state ----------
  const state = {
    population: null,
    loading: true,
    error: null,
    unit: 'month',
    rankingMetric: 'count',
    rankingMinPopulation: 0,
    timeMachine: null,
    timeMachineLoading: false,
    timeMachineError: null,
    timeMachineYear: 2026,
    projectionScenario: 'medium',
  };

  const charts = {};

  // ---------- helpers ----------
  function signed(value) { return `${value > 0 ? '+' : ''}${number.format(value)}`; }
  function signedPercent(value) { return `${value > 0 ? '+' : ''}${percent.format(value)}%`; }

  function formatMonth(period) {
    const [year, month] = period.split('-');
    return `${year} 年 ${Number(month)} 月`;
  }
  function compactMonth(period) {
    const [year, month] = period.split('-');
    return `${String(year).slice(2)}/${month}`;
  }
  function compactNumber(value) {
    const absolute = Math.abs(value);
    if (absolute >= 1_000_000) return `${(absolute / 1_000_000).toFixed(1)}M`;
    if (absolute >= 1_000) return `${Math.round(absolute / 1_000)}k`;
    return String(absolute);
  }

  function aggregateByYear(points) {
    const groups = new Map();
    const latestYear = points.at(-1)?.year;
    for (const point of points) {
      const current = groups.get(point.year) ?? { period: String(point.year), birth: 0, death: 0 };
      current.birth += point.birth;
      current.death += point.death;
      groups.set(point.year, current);
    }
    return [...groups.entries()].map(([year, value]) => ({
      ...value,
      period: year === latestYear && points.at(-1)?.month !== 12 ? `${year} YTD` : String(year),
    }));
  }

  function buildTrendComparison(trend) {
    const latest = trend.at(-1);
    const sameMonthLastYear = latest
      ? trend.find((item) => item.year === latest.year - 1 && item.month === latest.month)
      : undefined;
    const recent12 = trend.slice(-12);
    const previous12 = trend.slice(-24, -12);
    const sum = (items, key) => items.reduce((total, item) => total + item[key], 0);
    const changeRate = (current, previous) => (previous === 0 ? 0 : ((current - previous) / previous) * 100);

    return {
      birthYearOverYear: latest && sameMonthLastYear ? changeRate(latest.birth, sameMonthLastYear.birth) : 0,
      deathYearOverYear: latest && sameMonthLastYear ? changeRate(latest.death, sameMonthLastYear.death) : 0,
      birthRolling: changeRate(sum(recent12, 'birth'), sum(previous12, 'birth')),
      deathRolling: changeRate(sum(recent12, 'death'), sum(previous12, 'death')),
    };
  }

  function buildAgeStats(pyramid) {
    const sum = (items) => items.reduce((total, item) => total + item.male + item.female, 0);
    const children = sum(pyramid.slice(0, 3));
    const working = sum(pyramid.slice(3, 13));
    const older = sum(pyramid.slice(13));
    const total = Math.max(1, children + working + older);
    return {
      children, working, older,
      childrenShare: (children / total) * 100,
      workingShare: (working / total) * 100,
      olderShare: (older / total) * 100,
      agingIndex: children > 0 ? (older / children) * 100 : 0,
    };
  }

  function timeMachineShare(value, total) { return total > 0 ? (value / total) * 100 : 0; }

  function scenarioLabel(scenario) {
    return scenario === 'high' ? '高推估' : scenario === 'low' ? '低推估' : '中推估';
  }

  function buildTimeMachineTrend(payload) {
    if (!payload) return [];
    const actualRows = payload.actual.map((item) => ({ year: item.year, actual: item.total, high: null, medium: null, low: null }));
    const anchor = actualRows.at(-1);
    if (anchor) { anchor.high = anchor.actual; anchor.medium = anchor.actual; anchor.low = anchor.actual; }
    return [
      ...actualRows,
      ...payload.projections.medium.map((item, index) => ({
        year: item.year,
        actual: null,
        high: payload.projections.high[index]?.total ?? null,
        medium: item.total,
        low: payload.projections.low[index]?.total ?? null,
      })),
    ];
  }

  function buildTimeMachineObservation(payload, snapshot, year, scenario) {
    if (!payload || !snapshot) return { title: '等待人口時間軸資料', body: '載入後顯示這一年的結構變化。' };
    const series = year <= payload.actualThrough ? payload.actual : payload.projections[scenario];
    const index = series.findIndex((item) => item.year === year);
    const previous = index > 0 ? series[index - 1] : (year === payload.projectionFrom ? payload.actual.at(-1) : undefined);
    const yearlyRate = previous ? ((snapshot.total - previous.total) / previous.total) * 100 : null;
    const olderShare = timeMachineShare(snapshot.older, snapshot.total);

    const title = snapshot.older > snapshot.working
      ? '65 歲以上人口已超過工作年齡人口'
      : snapshot.older > snapshot.children * 3
        ? `高齡人口約為兒少的 ${(snapshot.older / snapshot.children).toFixed(1)} 倍`
        : `每 100 名兒少，約有 ${number.format(Math.round(snapshot.agingIndex))} 名高齡者`;
    const comparison = yearlyRate === null
      ? '這是時間軸起點，未計算前一年變化。'
      : `總人口較前一年 ${yearlyRate >= 0 ? '增加' : '減少'} ${percent.format(Math.abs(yearlyRate))}%。`;

    return {
      title,
      body: `${year} 年總人口為 ${number.format(snapshot.total)} 人，65 歲以上占 ${percent.format(olderShare)}%。${comparison}`,
    };
  }

  // ---------- data loading ----------
  async function loadPopulation() {
    state.loading = true;
    state.error = null;
    try {
      const response = await fetch('data/population.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('共用資料暫時無法讀取');
      const payload = await response.json();
      state.population = payload;
      try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload)); } catch { /* ignore */ }
    } catch (caught) {
      state.error = caught instanceof Error ? caught.message : '官方資料同步失敗';
    } finally {
      state.loading = false;
      render();
    }
  }

  function restoreCachedPopulation() {
    try {
      const cached = window.localStorage.getItem(CACHE_KEY);
      if (cached) state.population = JSON.parse(cached);
    } catch {
      try { window.localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
    }
  }

  function setupTimeMachineLazyLoad() {
    const section = document.getElementById('time-machine-section');
    if (!section) return;

    const load = async () => {
      state.timeMachineLoading = true;
      state.timeMachineError = null;
      renderTimeMachineState();
      try {
        const response = await fetch('data/population-time-machine.json');
        if (!response.ok) throw new Error('人口時間機資料載入失敗');
        const payload = await response.json();
        state.timeMachine = payload;
        state.timeMachineYear = payload.projectionFrom;
        renderTimeMachine();
      } catch (caught) {
        state.timeMachineError = caught instanceof Error ? caught.message : '人口時間機資料載入失敗';
        renderTimeMachineState();
      } finally {
        state.timeMachineLoading = false;
      }
    };

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        void load();
      }
    }, { rootMargin: '360px 0px' });
    observer.observe(section);

    document.getElementById('time-machine-retry').addEventListener('click', () => {
      state.timeMachineError = null;
      void load();
    });
  }

  // ---------- render: header / stats / warning ----------
  function render() {
    const population = state.population;

    // sync indicator
    const dot = document.getElementById('status-dot');
    const label = document.getElementById('sync-label');
    if (!population) {
      label.textContent = '讀取共用資料中';
      dot.classList.remove('stale');
    } else if (population.stale) {
      label.textContent = '顯示已查證快照';
      dot.classList.add('stale');
    } else {
      label.textContent = '每日資料已同步';
      dot.classList.remove('stale');
    }

    // refresh button
    const refreshBtn = document.getElementById('refresh-btn');
    refreshBtn.disabled = state.loading;
    refreshBtn.classList.toggle('btn-primary', !!population?.stale);
    refreshBtn.querySelector('.icon-refresh')?.classList.toggle('spin', state.loading);

    // latest month chip
    document.getElementById('latest-month-label').textContent = population ? formatMonth(population.latestMonth) : '—';

    // warning banner
    const banner = document.getElementById('warning-banner');
    const warningText = document.getElementById('warning-text');
    if (state.error || population?.stale) {
      banner.hidden = false;
      warningText.textContent = state.error
        ? `${state.error}；目前保留畫面中最後一次成功資料。`
        : (population?.syncWarning ?? '');
    } else {
      banner.hidden = true;
    }

    renderStatCards();
    renderTrendSection();
    renderPyramidSection();
    renderRankingSection();
    renderFooter();
  }

  function renderStatCards() {
    const population = state.population;
    const trend = population?.trend ?? [];
    const latestTrend = trend.at(-1);
    const previousTrend = trend.at(-2);

    document.getElementById('stat-population').textContent = population ? number.format(population.totals.population) + ' 人' : '同步中';
    document.getElementById('stat-population-note').textContent = population ? `較上月 ${signed(population.totals.monthlyChange)} 人` : '正在取得戶政資料';

    const birthValue = population?.totals.birth ?? latestTrend?.birth ?? 0;
    document.getElementById('stat-birth').textContent = number.format(birthValue) + ' 人';
    document.getElementById('stat-birth-note').textContent = (latestTrend && previousTrend)
      ? `較上月 ${signed(latestTrend.birth - previousTrend.birth)} 人` : '每月出生登記數';

    const deathValue = population?.totals.death ?? latestTrend?.death ?? 0;
    document.getElementById('stat-death').textContent = number.format(deathValue) + ' 人';
    document.getElementById('stat-death-note').textContent = (latestTrend && previousTrend)
      ? `較上月 ${signed(latestTrend.death - previousTrend.death)} 人` : '每月死亡登記數';

    const naturalChange = population?.totals.naturalChange ?? ((latestTrend?.birth ?? 0) - (latestTrend?.death ?? 0));
    document.getElementById('stat-change').textContent = number.format(naturalChange) + ' 人';
  }

  // ---------- trend section ----------
  function currentTrendSource() {
    return state.population?.trend ?? [];
  }

  function renderTrendSection() {
    const sourceTrend = currentTrendSource();
    if (!sourceTrend.length) return;

    const chartData = state.unit === 'month' ? sourceTrend.slice(-60) : aggregateByYear(sourceTrend);
    const comparison = buildTrendComparison(sourceTrend);
    const population = state.population;

    document.getElementById('birth-yoy').textContent = signedPercent(comparison.birthYearOverYear);
    document.getElementById('death-yoy').textContent = signedPercent(comparison.deathYearOverYear);
    document.getElementById('birth-rolling').textContent = signedPercent(comparison.birthRolling);
    document.getElementById('death-rolling').textContent = signedPercent(comparison.deathRolling);

    const rocLabel = population
      ? `民國 ${Number(population.latestRocMonth.slice(0, 3))} 年 ${Number(population.latestRocMonth.slice(3, 5))} 月`
      : '';
    document.getElementById('trend-unit-note').textContent = `單位：人${rocLabel ? '・' + rocLabel : ''}`;

    const labels = chartData.map((d) => d.period);
    const births = chartData.map((d) => d.birth);
    const deaths = chartData.map((d) => d.death);

    if (!charts.trend) {
      charts.trend = new Chart(document.getElementById('trend-chart'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: '出生人口', data: births, borderColor: COLORS.birth, backgroundColor: COLORS.birth, borderWidth: 3, pointRadius: 0, pointHoverRadius: 4, tension: 0.3 },
            { label: '死亡人口', data: deaths, borderColor: COLORS.death, backgroundColor: COLORS.death, borderWidth: 3, pointRadius: 0, pointHoverRadius: 4, tension: 0.3 },
          ],
        },
        options: trendChartOptions(),
      });
    } else {
      charts.trend.data.labels = labels;
      charts.trend.data.datasets[0].data = births;
      charts.trend.data.datasets[1].data = deaths;
      charts.trend.update();
    }
  }

  function trendChartOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const raw = items[0]?.label ?? '';
              return state.unit === 'month' && /^\d{4}-\d{2}$/.test(raw) ? formatMonth(raw) : raw;
            },
            label: (item) => `${item.dataset.label}：${number.format(item.parsed.y)} 人`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { callback(value) {
          const raw = this.getLabelForValue(value);
          return state.unit === 'month' ? compactMonth(raw) : raw;
        }, maxRotation: 0, autoSkip: true } },
        y: { grid: { color: 'rgba(148,163,184,0.25)' }, ticks: { callback: (v) => compactNumber(v) } },
      },
    };
  }

  // ---------- pyramid section ----------
  function renderPyramidSection() {
    const population = state.population;
    const pyramid = population?.pyramid ?? [];
    if (!pyramid.length) return;

    const ageStats = buildAgeStats(pyramid);
    document.getElementById('am-children').textContent = `${percent.format(ageStats.childrenShare)}%`;
    document.getElementById('am-children-note').textContent = `${number.format(ageStats.children)} 人`;
    document.getElementById('am-working').textContent = `${percent.format(ageStats.workingShare)}%`;
    document.getElementById('am-working-note').textContent = `${number.format(ageStats.working)} 人`;
    document.getElementById('am-older').textContent = `${percent.format(ageStats.olderShare)}%`;
    document.getElementById('am-older-note').textContent = `${number.format(ageStats.older)} 人`;
    document.getElementById('am-aging').textContent = percent.format(ageStats.agingIndex);

    document.getElementById('total-male').textContent = number.format(population.totals.male);
    document.getElementById('total-female').textContent = number.format(population.totals.female);
    document.getElementById('pyramid-sub').textContent = `全臺戶籍人口・每 5 歲為一級距・${formatMonth(population.latestMonth)}`;

    const reversed = [...pyramid].reverse();
    const labels = reversed.map((item) => item.age);
    const male = reversed.map((item) => -item.male);
    const female = reversed.map((item) => item.female);
    const max = Math.max(1, ...reversed.flatMap((item) => [Math.abs(item.male), item.female]));

    charts.pyramid = renderPyramidChart(charts.pyramid, 'pyramid-chart', labels, male, female, max);
  }

  function renderPyramidChart(existing, canvasId, labels, male, female, max) {
    const data = {
      labels,
      datasets: [
        { label: '男性', data: male, backgroundColor: COLORS.male, borderRadius: 5, barPercentage: 0.85, categoryPercentage: 0.9 },
        { label: '女性', data: female, backgroundColor: COLORS.female, borderRadius: 5, barPercentage: 0.85, categoryPercentage: 0.9 },
      ],
    };
    const options = {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (item) => `${item.dataset.label}：${number.format(Math.abs(item.raw))}` } },
      },
      scales: {
        x: { min: -max, max, grid: { color: 'rgba(148,163,184,0.25)' }, ticks: { callback: (v) => compactNumber(Math.abs(v)) } },
        y: { grid: { display: false }, ticks: { font: { size: 10 } } },
      },
    };
    if (!existing) return new Chart(document.getElementById(canvasId), { type: 'bar', data, options });
    existing.data = data;
    existing.options = options;
    existing.update();
    return existing;
  }

  // ---------- ranking section ----------
  function computeRankingView() {
    const population = state.population;
    if (!population) return { increase: [], decrease: [], coverage: 0 };
    if (state.rankingMetric === 'count') {
      return { increase: population.topIncrease, decrease: population.topDecrease, coverage: population.rankingCoverage };
    }
    const eligible = (population.townChanges ?? []).filter((item) => item.previous >= state.rankingMinPopulation);
    if (!eligible.length) {
      return { increase: population.topRateIncrease, decrease: population.topRateDecrease, coverage: population.rankingCoverage };
    }
    return {
      increase: eligible.filter((item) => item.change > 0).sort((a, b) => b.rate - a.rate).slice(0, 10),
      decrease: eligible.filter((item) => item.change < 0).sort((a, b) => a.rate - b.rate).slice(0, 10),
      coverage: eligible.length,
    };
  }

  function renderRankingSection() {
    const population = state.population;
    document.getElementById('threshold-row').hidden = state.rankingMetric !== 'rate';

    if (population) {
      document.getElementById('ranking-sub').textContent =
        `${population.previousMonth.replace('-', '/')} → ${population.latestMonth.replace('-', '/')}・納入 ${computeRankingView().coverage} 個行政區`;
    }

    const view = computeRankingView();
    renderRankingList('ranking-increase-list', view.increase, 'increase');
    renderRankingList('ranking-decrease-list', view.decrease, 'decrease');
  }

  function renderRankingList(listId, items, tone) {
    const list = document.getElementById(listId);
    list.innerHTML = '';
    const values = items.map((item) => Math.abs(state.rankingMetric === 'count' ? item.change : item.rate));
    const max = Math.max(Number.EPSILON, ...values);

    items.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'rank-item';
      const valueText = state.rankingMetric === 'count' ? `${signed(item.change)} 人` : signedPercent(item.rate);
      const metaText = state.rankingMetric === 'count'
        ? `本月 ${number.format(item.current)} 人・${signedPercent(item.rate)}`
        : `本月 ${number.format(item.current)} 人・${signed(item.change)} 人`;
      const width = Math.max(7, (Math.abs(state.rankingMetric === 'count' ? item.change : item.rate) / max) * 100);

      li.innerHTML = `
        <span class="rank-number">${index + 1}</span>
        <div class="rank-body">
          <div class="rank-top">
            <span class="rank-name" title="${item.name}">${item.name}</span>
            <span class="rank-value ${tone}">${valueText}</span>
          </div>
          <div class="rank-bar-track"><div class="rank-bar-fill ${tone}" style="width:${width}%"></div></div>
          <p class="rank-meta">${metaText}</p>
        </div>`;
      list.appendChild(li);
    });
  }

  // ---------- footer ----------
  function renderFooter() {
    const population = state.population;
    const el = document.getElementById('generated-at-label');
    if (population) {
      const generated = new Date(population.generatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
      el.textContent = `網站資料產製時間：${generated}`;
    } else {
      el.textContent = '';
    }
  }

  // ---------- time machine ----------
  function renderTimeMachineState() {
    const loadingEl = document.getElementById('time-machine-loading');
    const errorEl = document.getElementById('time-machine-error');
    const bodyEl = document.getElementById('time-machine-body');

    if (state.timeMachineError) {
      loadingEl.hidden = true; bodyEl.hidden = true; errorEl.hidden = false;
      document.getElementById('time-machine-error-text').textContent = state.timeMachineError;
    } else if (!state.timeMachine) {
      loadingEl.hidden = false; errorEl.hidden = true; bodyEl.hidden = true;
    }
  }

  function currentSnapshot() {
    const tm = state.timeMachine;
    if (!tm) return null;
    if (state.timeMachineYear <= tm.actualThrough) {
      return tm.actual.find((item) => item.year === state.timeMachineYear) ?? null;
    }
    return tm.projections[state.projectionScenario].find((item) => item.year === state.timeMachineYear) ?? null;
  }

  function renderTimeMachine() {
    const tm = state.timeMachine;
    if (!tm) return;
    document.getElementById('time-machine-loading').hidden = true;
    document.getElementById('time-machine-error').hidden = true;
    document.getElementById('time-machine-body').hidden = false;

    document.getElementById('tm-slider').min = tm.actual[0].year;
    document.getElementById('tm-slider').max = tm.projectionThrough;
    document.getElementById('tm-tick-start').textContent = `${tm.actual[0].year} 實際`;
    document.getElementById('tm-tick-actual-through').textContent = `${tm.actualThrough} 實際終點`;
    document.getElementById('tm-tick-projection-from').textContent = `${tm.projectionFrom} 推估起點`;
    document.getElementById('tm-tick-end').textContent = `${tm.projectionThrough} 推估`;

    document.getElementById('tm-source-label').textContent = `資料：${tm.source.label}・更新 ${tm.source.releaseDate}`;
    document.getElementById('tm-source-link').href = tm.source.url;

    renderTimeMachineFrame();

    const trendData = buildTimeMachineTrend(tm);
    renderTimeMachineTrendChart(trendData, tm);
  }

  function renderTimeMachineFrame() {
    const tm = state.timeMachine;
    if (!tm) return;
    const snapshot = currentSnapshot();
    const year = state.timeMachineYear;
    const isActual = year <= tm.actualThrough;

    document.getElementById('tm-slider').value = year;
    document.getElementById('tm-year').textContent = year;

    const badge = document.getElementById('tm-kind-badge');
    badge.textContent = isActual ? '歷史實際' : `${scenarioLabel(state.projectionScenario)}・推估`;
    badge.classList.toggle('actual', isActual);

    document.getElementById('tm-fertility-note').hidden = isActual;

    document.querySelectorAll('#tm-scenario-toggle .segment').forEach((btn) => {
      btn.disabled = isActual;
      btn.classList.toggle('opacity-45', isActual);
    });

    if (!snapshot) return;

    document.getElementById('tm-total').textContent = `${number.format(snapshot.total)} 人`;
    document.getElementById('tm-children').textContent = `${number.format(snapshot.children)} 人`;
    document.getElementById('tm-children-note').textContent = `${percent.format(timeMachineShare(snapshot.children, snapshot.total))}%`;
    document.getElementById('tm-working').textContent = `${number.format(snapshot.working)} 人`;
    document.getElementById('tm-working-note').textContent = `${percent.format(timeMachineShare(snapshot.working, snapshot.total))}%`;
    document.getElementById('tm-older').textContent = `${number.format(snapshot.older)} 人`;
    document.getElementById('tm-older-note').textContent = `${percent.format(timeMachineShare(snapshot.older, snapshot.total))}%`;
    document.getElementById('tm-aging').textContent = percent.format(snapshot.agingIndex);

    document.getElementById('tm-pyramid-title').textContent = `${year} 年人口金字塔`;

    const reversed = [...snapshot.pyramid].reverse();
    const labels = reversed.map((item) => item.age);
    const male = reversed.map((item) => -item.male);
    const female = reversed.map((item) => item.female);
    const max = Math.max(1, ...reversed.flatMap((item) => [Math.abs(item.male), item.female]));
    charts.tmPyramid = renderPyramidChart(charts.tmPyramid, 'tm-pyramid-chart', labels, male, female, max);

    const observation = buildTimeMachineObservation(tm, snapshot, year, state.projectionScenario);
    document.getElementById('tm-observation-title').textContent = observation.title;
    document.getElementById('tm-observation-body').textContent = observation.body;

    updateTimeMachineTrendMarkers();
  }

  function renderTimeMachineTrendChart(trendData, tm) {
    const labels = trendData.map((d) => d.year);
    const datasets = [
      { label: '歷史實際', data: trendData.map((d) => d.actual), borderColor: COLORS.primary, borderWidth: 3, pointRadius: 0, spanGaps: false, tension: 0.25 },
      { label: '高推估', data: trendData.map((d) => d.high), borderColor: COLORS.projHigh, borderWidth: 2, borderDash: [7, 5], pointRadius: 0, spanGaps: false, tension: 0.25 },
      { label: '中推估', data: trendData.map((d) => d.medium), borderColor: COLORS.projMedium, borderWidth: 3, borderDash: [7, 5], pointRadius: 0, spanGaps: false, tension: 0.25 },
      { label: '低推估', data: trendData.map((d) => d.low), borderColor: COLORS.projLow, borderWidth: 2, borderDash: [7, 5], pointRadius: 0, spanGaps: false, tension: 0.25 },
    ];
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (item) => (item.parsed.y == null ? undefined : `${item.dataset.label}：${number.format(item.parsed.y)} 人`) } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } },
        y: { grid: { color: 'rgba(148,163,184,0.25)' }, ticks: { callback: (v) => compactNumber(v) } },
      },
    };
    if (!charts.tmTrend) {
      charts.tmTrend = new Chart(document.getElementById('tm-trend-chart'), { type: 'line', data: { labels, datasets }, options });
    } else {
      charts.tmTrend.data.labels = labels;
      charts.tmTrend.data.datasets.forEach((ds, i) => { ds.data = datasets[i].data; });
      charts.tmTrend.update();
    }
    updateTimeMachineTrendMarkers();
  }

  function updateTimeMachineTrendMarkers() {
    // Highlight the projection start year and the currently selected year as point markers,
    // since this static build uses plain Chart.js without the annotation plugin (kept dependency-free).
    const chart = charts.tmTrend;
    const tm = state.timeMachine;
    if (!chart || !tm) return;
    const labels = chart.data.labels;
    chart.data.datasets.forEach((ds) => {
      ds.pointRadius = labels.map((year) => (year === state.timeMachineYear ? 5 : 0));
      ds.pointBackgroundColor = ds.borderColor;
      ds.pointBorderColor = '#fff';
    });
    chart.update('none');
  }

  // ---------- events ----------
  function setupEvents() {
    document.getElementById('refresh-btn').addEventListener('click', () => void loadPopulation());

    document.getElementById('trend-unit-toggle').addEventListener('click', (event) => {
      const button = event.target.closest('[data-unit]');
      if (!button) return;
      state.unit = button.dataset.unit;
      document.querySelectorAll('#trend-unit-toggle .segment').forEach((btn) => btn.classList.toggle('segment-active', btn === button));
      renderTrendSection();
    });

    document.getElementById('ranking-metric-toggle').addEventListener('click', (event) => {
      const button = event.target.closest('[data-metric]');
      if (!button) return;
      state.rankingMetric = button.dataset.metric;
      document.querySelectorAll('#ranking-metric-toggle .segment').forEach((btn) => btn.classList.toggle('segment-active', btn === button));
      renderRankingSection();
    });

    document.getElementById('ranking-threshold-toggle').addEventListener('click', (event) => {
      const button = event.target.closest('[data-threshold]');
      if (!button) return;
      state.rankingMinPopulation = Number(button.dataset.threshold);
      document.querySelectorAll('#ranking-threshold-toggle .segment').forEach((btn) => btn.classList.toggle('segment-active', btn === button));
      renderRankingSection();
    });

    document.getElementById('tm-scenario-toggle').addEventListener('click', (event) => {
      const button = event.target.closest('[data-scenario]');
      if (!button || button.disabled) return;
      state.projectionScenario = button.dataset.scenario;
      document.querySelectorAll('#tm-scenario-toggle .segment').forEach((btn) => btn.classList.toggle('segment-active', btn === button));
      renderTimeMachineFrame();
    });

    document.getElementById('tm-slider').addEventListener('input', (event) => {
      state.timeMachineYear = Number(event.target.value);
      renderTimeMachineFrame();
    });
  }

  // ---------- init ----------
  function init() {
    restoreCachedPopulation();
    setupEvents();
    setupTimeMachineLazyLoad();
    render();
    void loadPopulation();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
