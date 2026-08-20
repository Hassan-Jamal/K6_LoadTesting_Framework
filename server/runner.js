'use strict';
/**
 * Owns the k6 child process for a run:
 *   - streams k6's JSON metric feed on stdout and folds it into 1s buckets
 *   - asks k6 to end a run gracefully over its REST API
 *   - persists script, raw summary, time series and the k6 HTML dashboard
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { generateScript, buildScenario, toDuration } = require('./generator');

// Metrics we fold into the live view. Everything else on the stream is skipped
// before it is ever parsed, which is what keeps this cheap at high RPS.
const TRACKED = new Set([
  'vus',
  'vus_max',
  'http_reqs',
  'http_req_duration',
  'http_req_waiting',
  'http_req_failed',
  'iterations',
  'checks',
  'data_sent',
  'data_received',
  'dropped_iterations',
]);

const BUCKET_SAMPLE_CAP = 5000; // per-second latency samples kept for percentiles
const ENDPOINT_SAMPLE_CAP = 5000; // per-endpoint reservoir for the whole run
const MAX_TICKS = 24 * 3600; // hard ceiling on retained time-series points
const MAX_LOG_LINES = 500;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function emptyBucket(second) {
  return {
    t: second,
    vus: 0,
    vusMax: 0,
    reqs: 0,
    failed: 0,
    failedSamples: 0,
    iterations: 0,
    checksPassed: 0,
    checksFailed: 0,
    dataSent: 0,
    dataReceived: 0,
    droppedIterations: 0,
    durations: [],
    durationCount: 0,
    ttfbSum: 0,
    ttfbCount: 0,
  };
}

/** Reservoir-samples into `arr` so a bucket can never blow up memory. */
function sampleInto(arr, cap, seen, value) {
  if (arr.length < cap) {
    arr.push(value);
    return;
  }
  const j = Math.floor(Math.random() * seen);
  if (j < cap) arr[j] = value;
}

/** Estimates the wall-clock length of a profile, for the progress bar. */
function plannedDurationSeconds(profile) {
  const parse = (d) => {
    const s = String(toDuration(d, '0s'));
    const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
    let total = 0;
    let m;
    while ((m = re.exec(s))) {
      const n = parseFloat(m[1]);
      total += m[2] === 'ms' ? n / 1000 : m[2] === 's' ? n : m[2] === 'm' ? n * 60 : n * 3600;
    }
    return total;
  };
  const scenario = buildScenario(profile);
  if (Array.isArray(scenario.stages)) {
    return scenario.stages.reduce((sum, s) => sum + parse(s.duration), 0);
  }
  if (scenario.duration) return parse(scenario.duration);
  if (scenario.maxDuration) return parse(scenario.maxDuration);
  return 0;
}

function restRequest(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : {},
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data || '{}'));
          } catch (e) {
            resolve({ raw: data });
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('k6 REST API timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class Runner extends EventEmitter {
  constructor(options) {
    super();
    this.k6Path = (options && options.k6Path) || 'k6';
    this.dataDir = options.dataDir;
    this.apiPort = (options && options.apiPort) || 6565;
    this.dashboardPort = (options && options.dashboardPort) || 5665;
    this.current = null;
  }

  isBusy() {
    return !!this.current && this.current.status === 'running';
  }

  getState() {
    if (!this.current) return null;
    const c = this.current;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      startedAt: c.startedAt,
      endedAt: c.endedAt || null,
      elapsed: c.endedAt
        ? Math.round((c.endedAt - c.startedAt) / 1000)
        : Math.round((Date.now() - c.startedAt) / 1000),
      plannedDuration: c.plannedDuration,
      dashboardUrl: 'http://127.0.0.1:' + this.dashboardPort,
      profile: c.profile,
      totals: this.totals(),
      ticks: c.ticks,
      endpoints: this.endpointRows(),
      statusCodes: c.statusCodes,
      errors: Object.values(c.errorSamples).slice(0, 25),
      log: c.log,
      paused: c.paused,
    };
  }

  totals(force) {
    const c = this.current;
    if (!c) return null;
    // Percentiles mean sorting a large reservoir, so they are refreshed on a
    // slower cadence than the counters that ride along with them.
    const now = Date.now();
    let quantiles = c.quantileCache;
    if (force || !quantiles || now - quantiles.at > 2000) {
      const durations = c.allDurations.slice().sort((a, b) => a - b);
      quantiles = c.quantileCache = {
        at: now,
        p50: percentile(durations, 50),
        p90: percentile(durations, 90),
        p95: percentile(durations, 95),
        p99: percentile(durations, 99),
      };
    }
    const elapsed = Math.max(
      1,
      ((c.endedAt || Date.now()) - c.startedAt) / 1000
    );
    return {
      requests: c.cum.reqs,
      failed: c.cum.failed,
      errorRate: c.cum.reqs ? (c.cum.failed / c.cum.reqs) * 100 : 0,
      iterations: c.cum.iterations,
      checksPassed: c.cum.checksPassed,
      checksFailed: c.cum.checksFailed,
      dataSent: c.cum.dataSent,
      dataReceived: c.cum.dataReceived,
      droppedIterations: c.cum.droppedIterations,
      avgRps: c.cum.reqs / elapsed,
      peakRps: c.cum.peakRps,
      peakVus: c.cum.peakVus,
      avg: c.cum.durationCount ? c.cum.durationSum / c.cum.durationCount : 0,
      min: c.cum.durationCount ? c.cum.durationMin : 0,
      max: c.cum.durationMax,
      p50: quantiles.p50,
      p90: quantiles.p90,
      p95: quantiles.p95,
      p99: quantiles.p99,
    };
  }

  endpointRows(force) {
    const c = this.current;
    if (!c) return [];
    const now = Date.now();
    const refresh = force || !c.endpointQuantilesAt || now - c.endpointQuantilesAt > 2000;
    if (refresh) c.endpointQuantilesAt = now;

    return Object.values(c.endpoints)
      .map((e) => {
        if (refresh) {
          const sorted = e.samples.slice().sort((a, b) => a - b);
          e.quantiles = {
            p90: percentile(sorted, 90),
            p95: percentile(sorted, 95),
            p99: percentile(sorted, 99),
          };
        }
        const q = e.quantiles || { p90: 0, p95: 0, p99: 0 };
        return {
          id: e.id,
          name: e.name,
          method: e.method,
          requests: e.count,
          failed: e.failed,
          errorRate: e.count ? (e.failed / e.count) * 100 : 0,
          avg: e.count ? e.sum / e.count : 0,
          min: e.min === Infinity ? 0 : e.min,
          max: e.max,
          p90: q.p90,
          p95: q.p95,
          p99: q.p99,
        };
      })
      .sort((a, b) => b.requests - a.requests);
  }

  // --- lifecycle ------------------------------------------------------------

  async start(spec) {
    if (this.isBusy()) throw new Error('A test is already running');

    const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6);
    const dir = path.join(this.dataDir, id);
    fs.mkdirSync(dir, { recursive: true });

    const script = generateScript(spec);
    const scriptPath = path.join(dir, 'script.js');
    fs.writeFileSync(scriptPath, script, 'utf8');

    const profile = spec.profile || {};
    const meta = {
      id,
      name: profile.name || 'Load test',
      createdAt: new Date().toISOString(),
      profile,
      variables: spec.variables || {},
      requests: (spec.requests || []).map((r) => ({
        id: r.id,
        name: r.name,
        method: r.method,
        url: r.url,
        expectStatus: r.expectStatus,
      })),
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

    const summaryPath = path.join(dir, 'summary.json');
    const reportPath = path.join(dir, 'k6-dashboard.html');

    const args = [
      'run',
      '--quiet',
      '--no-usage-report',
      '--address',
      '127.0.0.1:' + this.apiPort,
      '--summary-export',
      summaryPath,
      '--out',
      'json=-',
      '--out',
      'web-dashboard',
      scriptPath,
    ];

    const env = Object.assign({}, process.env, {
      K6_WEB_DASHBOARD_PORT: String(this.dashboardPort),
      K6_WEB_DASHBOARD_HOST: '127.0.0.1',
      K6_WEB_DASHBOARD_OPEN: 'false',
      K6_WEB_DASHBOARD_PERIOD: '1s',
      K6_WEB_DASHBOARD_EXPORT: reportPath,
      NO_COLOR: '1',
    });

    const child = spawn(this.k6Path, args, { env, windowsHide: true });

    this.current = {
      id,
      dir,
      name: meta.name,
      profile,
      meta,
      child,
      status: 'running',
      paused: false,
      startedAt: Date.now(),
      endedAt: null,
      plannedDuration: plannedDurationSeconds(profile),
      summaryPath,
      reportPath,
      scriptPath,
      stdoutRemainder: '',
      buckets: new Map(),
      ticks: [],
      log: [],
      endpoints: {},
      statusCodes: {},
      errorSamples: {},
      allDurations: [],
      seenDurations: 0,
      cum: {
        reqs: 0,
        failed: 0,
        iterations: 0,
        checksPassed: 0,
        checksFailed: 0,
        dataSent: 0,
        dataReceived: 0,
        droppedIterations: 0,
        durationSum: 0,
        durationCount: 0,
        durationMin: Infinity,
        durationMax: 0,
        peakRps: 0,
        peakVus: 0,
      },
      lastVus: 0,
      lastVusMax: 0,
      timeCache: { key: '', value: 0 },
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => this._onStderr(chunk));

    child.on('error', (err) => {
      this._log('error', 'Failed to start k6: ' + err.message);
      this._finish(-1, err.message);
    });
    child.on('close', (code) => this._finish(code));

    this.flushTimer = setInterval(() => this._flush(false), 1000);
    this.emit('start', this.getState());
    return this.getState();
  }

  _onStderr(chunk) {
    for (const line of chunk.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      const level = /level=error|ERRO/.test(text)
        ? 'error'
        : /level=warning|WARN/.test(text)
        ? 'warn'
        : 'info';
      this._log(level, text);
    }
  }

  _log(level, message) {
    const c = this.current;
    if (!c) return;
    const entry = { t: Date.now(), level, message: message.slice(0, 2000) };
    c.log.push(entry);
    if (c.log.length > MAX_LOG_LINES) c.log.splice(0, c.log.length - MAX_LOG_LINES);
    this.emit('log', entry);
  }

  _onStdout(chunk) {
    const c = this.current;
    if (!c) return;
    const data = c.stdoutRemainder + chunk;
    const lines = data.split('\n');
    c.stdoutRemainder = lines.pop();
    for (const line of lines) {
      if (line.length < 20 || line.charCodeAt(0) !== 123 /* { */) continue;
      // Point lines start with {"metric":"<name>"; definition lines do not.
      if (line.charCodeAt(2) !== 109 /* m */) continue;
      const nameEnd = line.indexOf('"', 11);
      if (nameEnd < 0) continue;
      const metric = line.slice(11, nameEnd);
      if (!TRACKED.has(metric)) continue;
      let point;
      try {
        point = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (point.type !== 'Point') continue;
      this._consume(metric, point.data);
    }
  }

  /**
   * k6 stamps points in local time with an offset ("...T11:23:08.897+05:00"),
   * so the whole string has to be parsed - slicing it and assuming UTC would
   * shift every bucket by the offset. The parse only happens when the second
   * rolls over, which keeps it off the hot path.
   */
  _secondOf(isoTime) {
    const c = this.current;
    const key = isoTime.slice(0, 19);
    if (c.timeCache.key === key) return c.timeCache.value;
    const parsed = new Date(isoTime).getTime();
    const value = Number.isFinite(parsed)
      ? Math.floor(parsed / 1000)
      : Math.floor(Date.now() / 1000);
    c.timeCache = { key, value };
    return value;
  }

  _bucketFor(second) {
    const c = this.current;
    let b = c.buckets.get(second);
    if (!b) {
      b = emptyBucket(second);
      c.buckets.set(second, b);
    }
    return b;
  }

  /** Endpoint rows are keyed on the tags the generated script attaches. */
  _endpointFor(tags) {
    const c = this.current;
    const key = tags.endpoint || tags.name || tags.url || 'request';
    let ep = c.endpoints[key];
    if (!ep) {
      ep = c.endpoints[key] = {
        id: key,
        name: tags.name || key,
        method: tags.method || '',
        count: 0,
        failed: 0,
        sum: 0,
        min: Infinity,
        max: 0,
        samples: [],
        quantiles: null,
      };
    }
    if (!ep.method && tags.method) ep.method = tags.method;
    return ep;
  }

  _consume(metric, d) {
    const c = this.current;
    const value = d.value;
    const tags = d.tags || {};
    const second = this._secondOf(d.time);
    const b = this._bucketFor(second);

    switch (metric) {
      case 'vus':
        b.vus = value;
        c.lastVus = value;
        if (value > c.cum.peakVus) c.cum.peakVus = value;
        break;

      case 'vus_max':
        b.vusMax = value;
        c.lastVusMax = value;
        break;

      case 'http_reqs': {
        b.reqs += value;
        c.cum.reqs += value;
        const status = tags.status || '0';
        c.statusCodes[status] = (c.statusCodes[status] || 0) + value;
        break;
      }

      case 'http_req_duration': {
        b.durationCount++;
        sampleInto(b.durations, BUCKET_SAMPLE_CAP, b.durationCount, value);
        c.cum.durationSum += value;
        c.cum.durationCount++;
        if (value < c.cum.durationMin) c.cum.durationMin = value;
        if (value > c.cum.durationMax) c.cum.durationMax = value;
        c.seenDurations++;
        sampleInto(c.allDurations, 50000, c.seenDurations, value);

        const ep = this._endpointFor(tags);
        ep.count++;
        ep.sum += value;
        if (value < ep.min) ep.min = value;
        if (value > ep.max) ep.max = value;
        sampleInto(ep.samples, ENDPOINT_SAMPLE_CAP, ep.count, value);
        break;
      }

      case 'http_req_waiting':
        b.ttfbSum += value;
        b.ttfbCount++;
        break;

      case 'http_req_failed': {
        b.failedSamples++;
        if (value === 1) {
          b.failed++;
          c.cum.failed++;
          this._endpointFor(tags).failed++;
          const code = tags.error_code || tags.status || 'unknown';
          const label = (tags.name || tags.url || 'request') + ' -> ' + code;
          if (!c.errorSamples[label]) {
            c.errorSamples[label] = {
              endpoint: tags.name || tags.url || 'request',
              status: tags.status || '0',
              errorCode: tags.error_code || '',
              error: tags.error || '',
              count: 0,
            };
          }
          c.errorSamples[label].count++;
        }
        break;
      }

      case 'iterations':
        b.iterations += value;
        c.cum.iterations += value;
        break;

      case 'dropped_iterations':
        b.droppedIterations += value;
        c.cum.droppedIterations += value;
        break;

      case 'checks':
        if (value === 1) {
          b.checksPassed++;
          c.cum.checksPassed++;
        } else {
          b.checksFailed++;
          c.cum.checksFailed++;
        }
        break;

      case 'data_sent':
        b.dataSent += value;
        c.cum.dataSent += value;
        break;

      case 'data_received':
        b.dataReceived += value;
        c.cum.dataReceived += value;
        break;

      default:
        break;
    }
  }

  /**
   * Turns every bucket that is now safely in the past into a tick and ships it.
   * One second of lag is kept so late-arriving points still land in their bucket.
   */
  _flush(final) {
    const c = this.current;
    if (!c) return;
    const cutoff = Math.floor(Date.now() / 1000) - (final ? -1 : 2);
    const ready = [];
    for (const second of c.buckets.keys()) {
      if (second <= cutoff) ready.push(second);
    }
    ready.sort((a, b) => a - b);

    for (const second of ready) {
      const b = c.buckets.get(second);
      c.buckets.delete(second);
      const sorted = b.durations.slice().sort((x, y) => x - y);
      const tick = {
        t: second,
        elapsed: second - Math.floor(c.startedAt / 1000),
        vus: b.vus || c.lastVus,
        vusMax: b.vusMax || c.lastVusMax,
        rps: b.reqs,
        iterations: b.iterations,
        failed: b.failed,
        errorRate: b.failedSamples ? (b.failed / b.failedSamples) * 100 : 0,
        checksPassed: b.checksPassed,
        checksFailed: b.checksFailed,
        dataSent: b.dataSent,
        dataReceived: b.dataReceived,
        dropped: b.droppedIterations,
        avg: sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0,
        min: sorted.length ? sorted[0] : 0,
        max: sorted.length ? sorted[sorted.length - 1] : 0,
        p50: percentile(sorted, 50),
        p90: percentile(sorted, 90),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        ttfb: b.ttfbCount ? b.ttfbSum / b.ttfbCount : 0,
      };
      if (tick.elapsed < 0) continue;
      if (tick.rps > c.cum.peakRps) c.cum.peakRps = tick.rps;
      c.ticks.push(tick);
      if (c.ticks.length > MAX_TICKS) c.ticks.shift();
      this.emit('tick', {
        runId: c.id,
        tick,
        totals: this.totals(),
        endpoints: this.endpointRows(),
        statusCodes: c.statusCodes,
        errors: Object.values(c.errorSamples).slice(0, 25),
        elapsed: Math.round((Date.now() - c.startedAt) / 1000),
        plannedDuration: c.plannedDuration,
        paused: c.paused,
      });
    }
  }

  _finish(code, errorMessage) {
    const c = this.current;
    if (!c || c.status !== 'running') return;
    clearInterval(this.flushTimer);
    this._flush(true);

    c.endedAt = Date.now();
    c.status = c.stopRequested ? 'stopped' : code === 0 ? 'passed' : 'failed';
    c.exitCode = code;

    let summary = null;
    try {
      summary = JSON.parse(fs.readFileSync(c.summaryPath, 'utf8'));
    } catch (e) {
      summary = null;
    }

    const thresholds = extractThresholds(summary);
    const checks = extractChecks(summary);
    const result = {
      id: c.id,
      name: c.name,
      status: c.status,
      exitCode: code,
      error: errorMessage || null,
      startedAt: new Date(c.startedAt).toISOString(),
      endedAt: new Date(c.endedAt).toISOString(),
      duration: Math.round((c.endedAt - c.startedAt) / 1000),
      profile: c.profile,
      requests: c.meta.requests,
      totals: this.totals(true),
      ticks: c.ticks,
      endpoints: this.endpointRows(true),
      statusCodes: c.statusCodes,
      errors: Object.values(c.errorSamples),
      thresholds,
      checks,
      summary,
      hasK6Report: fs.existsSync(c.reportPath),
      log: c.log.slice(-200),
    };

    try {
      fs.writeFileSync(path.join(c.dir, 'result.json'), JSON.stringify(result), 'utf8');
    } catch (e) {
      this._log('warn', 'Could not persist result.json: ' + e.message);
    }

    this.emit('end', result);
    this.lastResult = result;
  }

  // --- live control ---------------------------------------------------------

  async stop() {
    if (!this.isBusy()) throw new Error('No test is running');
    const c = this.current;
    c.stopRequested = true;
    this._log('warn', 'Stop requested - asking k6 to end the test gracefully');
    try {
      await restRequest(this.apiPort, 'PATCH', '/v1/status', {
        data: { type: 'status', id: 'default', attributes: { stopped: true } },
      });
    } catch (e) {
      this._log('warn', 'Graceful stop failed (' + e.message + '), killing the process');
      c.child.kill();
    }
    // Backstop: if k6 has not exited shortly after, terminate it hard.
    setTimeout(() => {
      if (c.status === 'running' && c.child.exitCode === null) {
        this._log('warn', 'k6 did not exit in time - forcing termination');
        c.child.kill('SIGKILL');
      }
    }, 15000).unref();
    return true;
  }
}

/**
 * Pulls the threshold table out of a k6 --summary-export document.
 * In that format the boolean is "breached", so `false` means the threshold held.
 */
function extractThresholds(summary) {
  const out = [];
  if (!summary || !summary.metrics) return out;
  for (const [metricName, metric] of Object.entries(summary.metrics)) {
    const th = metric && metric.thresholds;
    if (!th) continue;
    for (const [expression, detail] of Object.entries(th)) {
      const breached = typeof detail === 'boolean' ? detail : !!(detail && detail.fails);
      const actual = summariseMetricValue(metric, expression);
      out.push({ metric: metricName, expression, passed: !breached, actual });
    }
  }
  return out;
}

/** Best-effort "what the metric actually was" for the threshold table. */
function summariseMetricValue(metric, expression) {
  const stat = /^\s*([a-z0-9()]+)\s*[<>=]/i.exec(expression);
  const key = stat ? stat[1] : null;
  if (key && metric[key] != null) return metric[key];
  if (key === 'rate' && metric.value != null) return metric.value;
  if (metric.value != null) return metric.value;
  if (metric.count != null) return metric.count;
  return null;
}

/** Per-check pass/fail counts live in root_group in the exported summary. */
function extractChecks(summary) {
  const rows = [];
  const walk = (group) => {
    if (!group) return;
    for (const check of Object.values(group.checks || {})) {
      rows.push({
        name: check.name,
        passes: check.passes || 0,
        fails: check.fails || 0,
      });
    }
    for (const child of Object.values(group.groups || {})) walk(child);
  };
  walk(summary && summary.root_group);
  return rows;
}

module.exports = { Runner, plannedDurationSeconds, percentile, extractThresholds, extractChecks };
