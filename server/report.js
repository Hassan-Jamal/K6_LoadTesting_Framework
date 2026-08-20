'use strict';
/**
 * Renders a completed run into a single self-contained HTML file: charts,
 * SLA table, per-endpoint breakdown and errors, with Chart.js inlined so the
 * file can be mailed around or opened offline.
 */

const fs = require('fs');
const path = require('path');

const CHART_JS = path.join(__dirname, '..', 'public', 'vendor', 'chart.umd.js');

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ms(value) {
  const n = Number(value || 0);
  if (n >= 1000) return (n / 1000).toFixed(2) + ' s';
  return n.toFixed(1) + ' ms';
}

function num(value, digits) {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: digits || 0,
    maximumFractionDigits: digits || 0,
  });
}

function bytes(value) {
  const n = Number(value || 0);
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
}

function hhmmss(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function statusBadge(status) {
  const map = { passed: 'ok', failed: 'bad', stopped: 'warn' };
  return '<span class="badge ' + (map[status] || 'warn') + '">' + esc(status) + '</span>';
}

function buildReport(run) {
  const totals = run.totals || {};
  const ticks = run.ticks || [];
  const endpoints = run.endpoints || [];
  const thresholds = run.thresholds || [];
  const checks = run.checks || [];
  const errors = (run.errors || []).slice().sort((a, b) => b.count - a.count);
  const statusCodes = Object.entries(run.statusCodes || {}).sort((a, b) => b[1] - a[1]);

  let chartLib = '';
  try {
    chartLib = fs.readFileSync(CHART_JS, 'utf8');
  } catch (e) {
    chartLib = '';
  }

  const series = {
    labels: ticks.map((t) => t.elapsed),
    vus: ticks.map((t) => t.vus),
    rps: ticks.map((t) => t.rps),
    p95: ticks.map((t) => Math.round(t.p95 * 10) / 10),
    p99: ticks.map((t) => Math.round(t.p99 * 10) / 10),
    avg: ticks.map((t) => Math.round(t.avg * 10) / 10),
    errorRate: ticks.map((t) => Math.round(t.errorRate * 100) / 100),
  };

  const failedThresholds = thresholds.filter((t) => !t.passed).length;

  const profileRows = [
    ['Executor', (run.profile && run.profile.executor) || '-'],
    ['Flow', (run.profile && run.profile.flow) || 'sequence'],
    [
      'Stages',
      run.profile && run.profile.stages && run.profile.stages.length
        ? run.profile.stages.map((s) => s.duration + ' -> ' + s.target).join(', ')
        : '-',
    ],
    ['Think time', run.profile ? (run.profile.thinkTimeMin || 0) + ' - ' + (run.profile.thinkTimeMax || 0) + ' s' : '-'],
    ['Started', run.startedAt || '-'],
    ['Ended', run.endedAt || '-'],
    ['Wall clock', hhmmss(run.duration)],
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Load test report - ${esc(run.name)}</title>
<style>
  :root {
    --bg: #0e1117; --panel: #161b25; --panel2: #1c2230; --line: #263041;
    --text: #e6edf7; --muted: #8b98ad; --accent: #4f8cff; --ok: #2ecc8f;
    --bad: #ff5c72; --warn: #ffb454; --violet: #a97bff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.55 "Segoe UI", system-ui, -apple-system, sans-serif; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 32px 20px 64px; }
  header { border-bottom: 1px solid var(--line); padding-bottom: 20px; margin-bottom: 28px; }
  h1 { margin: 0 0 6px; font-size: 24px; letter-spacing: -0.02em; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.09em;
    color: var(--muted); margin: 34px 0 14px; font-weight: 600; }
  .sub { color: var(--muted); font-size: 13px; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .badge.ok { background: rgba(46,204,143,.16); color: var(--ok); }
  .badge.bad { background: rgba(255,92,114,.16); color: var(--bad); }
  .badge.warn { background: rgba(255,180,84,.16); color: var(--warn); }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
  .card .label { color: var(--muted); font-size: 11px; text-transform: uppercase;
    letter-spacing: .08em; margin-bottom: 6px; }
  .card .value { font-size: 24px; font-weight: 650; letter-spacing: -0.02em; }
  .card .value.small { font-size: 19px; }
  .chart-card { background: var(--panel); border: 1px solid var(--line);
    border-radius: 12px; padding: 16px 18px 8px; margin-bottom: 16px; }
  .chart-card h3 { margin: 0 0 12px; font-size: 14px; font-weight: 600; }
  .chart-box { position: relative; height: 260px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .07em; }
  tbody tr:hover { background: var(--panel2); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .scroll { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
  .ok-text { color: var(--ok); } .bad-text { color: var(--bad); } .muted { color: var(--muted); }
  code { background: var(--panel2); padding: 2px 6px; border-radius: 5px; font-size: 12px; }
  footer { margin-top: 44px; color: var(--muted); font-size: 12px;
    border-top: 1px solid var(--line); padding-top: 16px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(run.name)} ${statusBadge(run.status)}</h1>
    <div class="sub">${esc(run.startedAt || '')} &middot; ran for ${hhmmss(run.duration)} &middot;
      ${num(totals.requests)} requests &middot;
      ${failedThresholds ? '<span class="bad-text">' + failedThresholds + ' SLA breach(es)</span>' : '<span class="ok-text">all SLAs met</span>'}
    </div>
  </header>

  <div class="grid">
    <div class="card"><div class="label">Requests</div><div class="value">${num(totals.requests)}</div></div>
    <div class="card"><div class="label">Avg throughput</div><div class="value">${num(totals.avgRps, 1)}<span class="muted" style="font-size:13px"> /s</span></div></div>
    <div class="card"><div class="label">Peak throughput</div><div class="value">${num(totals.peakRps)}<span class="muted" style="font-size:13px"> /s</span></div></div>
    <div class="card"><div class="label">Peak VUs</div><div class="value">${num(totals.peakVus)}</div></div>
    <div class="card"><div class="label">Error rate</div><div class="value ${totals.errorRate > 0 ? 'bad-text' : 'ok-text'}">${num(totals.errorRate, 2)}%</div></div>
    <div class="card"><div class="label">p95 latency</div><div class="value">${ms(totals.p95)}</div></div>
    <div class="card"><div class="label">p99 latency</div><div class="value">${ms(totals.p99)}</div></div>
    <div class="card"><div class="label">Average latency</div><div class="value">${ms(totals.avg)}</div></div>
    <div class="card"><div class="label">Checks passed</div><div class="value small">${num(totals.checksPassed)} / ${num((totals.checksPassed || 0) + (totals.checksFailed || 0))}</div></div>
    <div class="card"><div class="label">Data received</div><div class="value small">${bytes(totals.dataReceived)}</div></div>
    <div class="card"><div class="label">Data sent</div><div class="value small">${bytes(totals.dataSent)}</div></div>
    <div class="card"><div class="label">Dropped iterations</div><div class="value small ${totals.droppedIterations ? 'bad-text' : ''}">${num(totals.droppedIterations)}</div></div>
  </div>

  <h2>Load profile and throughput</h2>
  <div class="chart-card"><h3>Virtual users vs requests per second</h3><div class="chart-box"><canvas id="c1"></canvas></div></div>
  <div class="chart-card"><h3>Response time over time</h3><div class="chart-box"><canvas id="c2"></canvas></div></div>
  <div class="chart-card"><h3>Error rate over time</h3><div class="chart-box"><canvas id="c3"></canvas></div></div>

  <h2>Service level thresholds</h2>
  <div class="scroll">
    <table>
      <thead><tr><th>Metric</th><th>Threshold</th><th class="num">Actual</th><th>Result</th></tr></thead>
      <tbody>
        ${
          thresholds.length
            ? thresholds
                .map(
                  (t) =>
                    '<tr><td><code>' + esc(t.metric) + '</code></td><td><code>' + esc(t.expression) +
                    '</code></td><td class="num">' + (t.actual == null ? '-' : num(t.actual, 2)) + '</td><td>' +
                    (t.passed ? '<span class="badge ok">pass</span>' : '<span class="badge bad">fail</span>') +
                    '</td></tr>'
                )
                .join('')
            : '<tr><td colspan="4" class="muted">No thresholds were configured for this run.</td></tr>'
        }
      </tbody>
    </table>
  </div>

  <h2>Endpoint breakdown</h2>
  <div class="scroll">
    <table>
      <thead><tr>
        <th>Endpoint</th><th class="num">Requests</th><th class="num">Failed</th><th class="num">Error %</th>
        <th class="num">Avg</th><th class="num">p90</th><th class="num">p95</th><th class="num">p99</th><th class="num">Max</th>
      </tr></thead>
      <tbody>
        ${
          endpoints.length
            ? endpoints
                .map(
                  (e) =>
                    '<tr><td>' + esc(e.name) + '</td>' +
                    '<td class="num">' + num(e.requests) + '</td>' +
                    '<td class="num">' + num(e.failed) + '</td>' +
                    '<td class="num ' + (e.errorRate > 0 ? 'bad-text' : '') + '">' + num(e.errorRate, 2) + '%</td>' +
                    '<td class="num">' + ms(e.avg) + '</td><td class="num">' + ms(e.p90) + '</td>' +
                    '<td class="num">' + ms(e.p95) + '</td><td class="num">' + ms(e.p99) + '</td>' +
                    '<td class="num">' + ms(e.max) + '</td></tr>'
                )
                .join('')
            : '<tr><td colspan="9" class="muted">No endpoint data captured.</td></tr>'
        }
      </tbody>
    </table>
  </div>

  <h2>Checks</h2>
  <div class="scroll">
    <table>
      <thead><tr><th>Check</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Success rate</th></tr></thead>
      <tbody>
        ${
          checks.length
            ? checks
                .map((c) => {
                  const total = (c.passes || 0) + (c.fails || 0);
                  const rate = total ? ((c.passes || 0) / total) * 100 : 0;
                  return '<tr><td>' + esc(c.name) + '</td><td class="num">' + num(c.passes) +
                    '</td><td class="num">' + num(c.fails) + '</td><td class="num ' +
                    (rate < 100 ? 'bad-text' : 'ok-text') + '">' + num(rate, 2) + '%</td></tr>';
                })
                .join('')
            : '<tr><td colspan="4" class="muted">No checks recorded.</td></tr>'
        }
      </tbody>
    </table>
  </div>

  <h2>Status codes and errors</h2>
  <div class="scroll" style="margin-bottom:16px">
    <table>
      <thead><tr><th>HTTP status</th><th class="num">Responses</th><th class="num">Share</th></tr></thead>
      <tbody>
        ${
          statusCodes.length
            ? statusCodes
                .map(
                  ([code, count]) =>
                    '<tr><td>' + esc(code) + '</td><td class="num">' + num(count) + '</td><td class="num">' +
                    num(totals.requests ? (count / totals.requests) * 100 : 0, 2) + '%</td></tr>'
                )
                .join('')
            : '<tr><td colspan="3" class="muted">No responses recorded.</td></tr>'
        }
      </tbody>
    </table>
  </div>
  <div class="scroll">
    <table>
      <thead><tr><th>Failing endpoint</th><th>Status</th><th>k6 error code</th><th class="num">Occurrences</th></tr></thead>
      <tbody>
        ${
          errors.length
            ? errors
                .map(
                  (e) =>
                    '<tr><td>' + esc(e.endpoint) + '</td><td>' + esc(e.status) + '</td><td>' +
                    esc(e.errorCode || '-') + '</td><td class="num">' + num(e.count) + '</td></tr>'
                )
                .join('')
            : '<tr><td colspan="4" class="muted">No failed requests. </td></tr>'
        }
      </tbody>
    </table>
  </div>

  <h2>Run configuration</h2>
  <div class="scroll">
    <table><tbody>
      ${profileRows.map((r) => '<tr><td style="width:200px" class="muted">' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>').join('')}
    </tbody></table>
  </div>

  <footer>Generated by k6 Load Lab &middot; run id <code>${esc(run.id)}</code></footer>
</div>

<script>${chartLib}</script>
<script>
const S = ${JSON.stringify(series)};
const grid = { color: 'rgba(255,255,255,0.06)' };
const tickColor = '#8b98ad';
const base = (yTitle) => ({
  responsive: true, maintainAspectRatio: false, animation: false,
  interaction: { mode: 'index', intersect: false },
  plugins: { legend: { labels: { color: '#e6edf7', boxWidth: 12, usePointStyle: true } } },
  scales: {
    x: { grid, ticks: { color: tickColor, maxTicksLimit: 12 },
         title: { display: true, text: 'seconds into test', color: tickColor } },
    y: { grid, ticks: { color: tickColor }, beginAtZero: true,
         title: { display: true, text: yTitle, color: tickColor } }
  }
});

if (window.Chart && S.labels.length) {
  new Chart(document.getElementById('c1'), {
    type: 'line',
    data: { labels: S.labels, datasets: [
      { label: 'Virtual users', data: S.vus, borderColor: '#a97bff',
        backgroundColor: 'rgba(169,123,255,.16)', fill: true, tension: .25,
        pointRadius: 0, borderWidth: 2, yAxisID: 'y' },
      { label: 'Requests/s', data: S.rps, borderColor: '#4f8cff',
        backgroundColor: 'rgba(79,140,255,.12)', fill: true, tension: .25,
        pointRadius: 0, borderWidth: 2, yAxisID: 'y1' }
    ]},
    options: Object.assign(base('VUs'), { scales: {
      x: { grid, ticks: { color: tickColor, maxTicksLimit: 12 },
           title: { display: true, text: 'seconds into test', color: tickColor } },
      y: { position: 'left', grid, ticks: { color: tickColor }, beginAtZero: true,
           title: { display: true, text: 'VUs', color: tickColor } },
      y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: tickColor },
            beginAtZero: true, title: { display: true, text: 'requests/s', color: tickColor } }
    }})
  });

  new Chart(document.getElementById('c2'), {
    type: 'line',
    data: { labels: S.labels, datasets: [
      { label: 'avg', data: S.avg, borderColor: '#2ecc8f', pointRadius: 0, borderWidth: 2, tension: .25 },
      { label: 'p95', data: S.p95, borderColor: '#ffb454', pointRadius: 0, borderWidth: 2, tension: .25 },
      { label: 'p99', data: S.p99, borderColor: '#ff5c72', pointRadius: 0, borderWidth: 2, tension: .25 }
    ]},
    options: base('milliseconds')
  });

  new Chart(document.getElementById('c3'), {
    type: 'line',
    data: { labels: S.labels, datasets: [
      { label: 'error rate %', data: S.errorRate, borderColor: '#ff5c72',
        backgroundColor: 'rgba(255,92,114,.18)', fill: true, pointRadius: 0,
        borderWidth: 2, tension: .25 }
    ]},
    options: base('percent')
  });
}
</script>
</body>
</html>`;
}

module.exports = { buildReport };
