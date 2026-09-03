'use strict';
/**
 * k6 Load Lab - HTTP API + live WebSocket feed for the browser UI.
 *
 *   npm start            http://localhost:4300
 *   PORT=5000 npm start  different port
 */

const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const { parseCollection } = require('./postman');
const { generateScript } = require('./generator');
const { Runner, plannedDurationSeconds } = require('./runner');
const { Store } = require('./store');
const { buildReport } = require('./report');
const { PRESETS } = require('./presets');
const { openInBrowser } = require('./open');

const ROOT = path.join(__dirname, '..');
// Same convention as the CLI: runs live beside the folder you launched from.
const DATA_DIR = process.env.K6LAB_DATA
  ? path.resolve(process.cwd(), process.env.K6LAB_DATA)
  : path.join(process.cwd(), 'k6lab-runs');
const PORT = Number(process.env.PORT || 4300);
const K6_PATH = process.env.K6_PATH || 'k6';
const K6_API_PORT = Number(process.env.K6_API_PORT || 6565);
const K6_DASHBOARD_PORT = Number(process.env.K6_DASHBOARD_PORT || 5665);

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const store = new Store(DATA_DIR);
const runner = new Runner({
  k6Path: K6_PATH,
  dataDir: DATA_DIR,
  apiPort: K6_API_PORT,
  dashboardPort: K6_DASHBOARD_PORT,
});

app.use(express.json({ limit: '128mb' }));
/**
 * Chart.js is served straight out of node_modules. Copying it into public/ at
 * install time used to work, but a user installing with --ignore-scripts would
 * silently get a console with no charts.
 */
function chartJsPath() {
  try {
    // chart.js restricts deep subpaths through "exports", so resolve the
    // package entry point and walk back to its root to reach the UMD build.
    const entry = require.resolve('chart.js'); // .../chart.js/dist/chart.cjs
    const candidate = path.join(path.dirname(entry), 'chart.umd.js');
    if (fs.existsSync(candidate)) return candidate;
  } catch (err) {
    /* not installed - fall through */
  }
  const vendored = path.join(ROOT, 'public', 'vendor', 'chart.umd.js');
  return fs.existsSync(vendored) ? vendored : null;
}

app.get('/vendor/chart.umd.js', (req, res, next) => {
  const file = chartJsPath();
  if (!file) return next();
  res.type('application/javascript').sendFile(file);
});

app.use(express.static(path.join(ROOT, 'public')));

// --- live feed --------------------------------------------------------------

function broadcast(type, payload) {
  const message = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(message);
  }
}

runner.on('start', (state) => broadcast('run:start', state));
runner.on('tick', (data) => broadcast('run:tick', data));
runner.on('log', (entry) => broadcast('run:log', entry));
runner.on('end', (result) => {
  writeReport(result.id, result);
  broadcast('run:end', result);
});

wss.on('connection', (socket) => {
  const state = runner.getState();
  socket.send(JSON.stringify({ type: 'hello', payload: { running: runner.isBusy(), state } }));
});

function writeReport(id, result) {
  try {
    const html = buildReport(Object.assign({ id }, result));
    fs.writeFileSync(path.join(store.runDir(id), 'report.html'), html, 'utf8');
  } catch (err) {
    console.error('[report] failed to render:', err.message);
  }
}

// --- environment ------------------------------------------------------------

app.get('/api/health', (req, res) => {
  const { execFile } = require('child_process');
  execFile(K6_PATH, ['version'], { windowsHide: true }, (err, stdout) => {
    res.json({
      ok: !err,
      k6: err ? null : String(stdout).trim(),
      k6Path: K6_PATH,
      error: err ? err.message : null,
      running: runner.isBusy(),
      dashboardUrl: 'http://127.0.0.1:' + K6_DASHBOARD_PORT,
      host: os.hostname(),
      cpus: os.cpus().length,
    });
  });
});

app.get('/api/presets', (req, res) => res.json({ presets: PRESETS }));

// --- importing --------------------------------------------------------------

app.post('/api/import/postman', (req, res) => {
  try {
    const { collection, environment } = req.body || {};
    const parsed = parseCollection(collection, environment);
    res.json(parsed);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Convenience for a collection that already lives on this machine. */
app.post('/api/import/path', (req, res) => {
  try {
    const filePath = String((req.body && req.body.path) || '').replace(/^["']|["']$/g, '');
    if (!filePath) throw new Error('Provide a path to a postman_collection.json file');
    const collection = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    let environment = null;
    if (req.body.environmentPath) {
      environment = JSON.parse(fs.readFileSync(String(req.body.environmentPath), 'utf8'));
    }
    res.json(parseCollection(collection, environment));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- runs -------------------------------------------------------------------

app.post('/api/preview', (req, res) => {
  try {
    const script = generateScript(req.body || {});
    res.json({
      script,
      plannedDuration: plannedDurationSeconds((req.body && req.body.profile) || {}),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/runs', async (req, res) => {
  try {
    const state = await runner.start(req.body || {});
    res.json(state);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/runs', (req, res) => {
  res.json({ runs: store.list(), running: runner.isBusy(), state: runner.getState() });
});

app.get('/api/runs/current', (req, res) => {
  res.json({ running: runner.isBusy(), state: runner.getState() });
});

app.post('/api/runs/current/stop', async (req, res) => {
  try {
    await runner.stop();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/runs/:id', (req, res) => {
  try {
    const run = store.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/runs/:id', (req, res) => {
  try {
    store.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/runs/:id/script', (req, res) => {
  try {
    res.type('text/plain').send(fs.readFileSync(store.scriptPath(req.params.id), 'utf8'));
  } catch (err) {
    res.status(404).json({ error: 'Script not found' });
  }
});

app.get('/reports/:id/report.html', (req, res) => {
  try {
    const file = path.join(store.runDir(req.params.id), 'report.html');
    if (!fs.existsSync(file)) {
      const run = store.get(req.params.id);
      if (!run) return res.status(404).send('Run not found');
      writeReport(req.params.id, run);
    }
    res.type('html').send(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    res.status(404).send('Report not available');
  }
});

app.get('/reports/:id/k6-dashboard.html', (req, res) => {
  try {
    const file = store.k6ReportPath(req.params.id);
    if (!fs.existsSync(file)) return res.status(404).send('k6 dashboard report not available for this run');
    res.type('html').send(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    res.status(404).send('Report not available');
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  k6 Load Lab');
  console.log('  UI            http://localhost:' + PORT);
  console.log('  live k6 chart http://127.0.0.1:' + K6_DASHBOARD_PORT + ' (while a test runs)');
  console.log('  k6 binary     ' + K6_PATH);
  console.log('  data          ' + DATA_DIR);
  console.log('');
  if (process.env.K6LAB_OPEN !== '0') openInBrowser('http://localhost:' + PORT);
});

process.on('SIGINT', () => {
  if (runner.isBusy()) runner.stop().catch(() => {});
  setTimeout(() => process.exit(0), 500);
});
