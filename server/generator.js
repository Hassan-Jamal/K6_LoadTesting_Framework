'use strict';
/**
 * Builds a standalone, human-readable k6 script from a normalised request list
 * plus a load profile. The generated file is saved with every run so any test
 * can be re-run with plain `k6 run script.js`, with or without this UI.
 */

const MAX_PER_ENDPOINT_METRICS = 60;

function jsLiteral(value) {
  // Safe to embed in a .js file: escape the separators that break JS parsing.
  return JSON.stringify(value, null, 2)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function toDuration(value, fallback) {
  if (value == null || value === '') return fallback;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return s + 's';
  return s;
}

function buildScenario(profile) {
  const exec = profile.executor || 'ramping-vus';
  const startVUs = Number(profile.startVUs || 0);

  switch (exec) {
    case 'constant-vus':
      return {
        executor: 'constant-vus',
        vus: Number(profile.vus || 10),
        duration: toDuration(profile.duration, '1m'),
        gracefulStop: toDuration(profile.gracefulStop, '30s'),
      };

    case 'ramping-arrival-rate':
      return {
        executor: 'ramping-arrival-rate',
        startRate: Number(profile.startRate || 0),
        timeUnit: '1s',
        preAllocatedVUs: Number(profile.preAllocatedVUs || 50),
        maxVUs: Number(profile.maxVUs || 200),
        stages: (profile.stages || []).map((s) => ({
          duration: toDuration(s.duration, '30s'),
          target: Number(s.target || 0),
        })),
        gracefulStop: toDuration(profile.gracefulStop, '30s'),
      };

    case 'constant-arrival-rate':
      return {
        executor: 'constant-arrival-rate',
        rate: Number(profile.rate || 10),
        timeUnit: '1s',
        duration: toDuration(profile.duration, '1m'),
        preAllocatedVUs: Number(profile.preAllocatedVUs || 50),
        maxVUs: Number(profile.maxVUs || 200),
        gracefulStop: toDuration(profile.gracefulStop, '30s'),
      };

    case 'shared-iterations':
      return {
        executor: 'shared-iterations',
        vus: Number(profile.vus || 10),
        iterations: Number(profile.iterations || 100),
        maxDuration: toDuration(profile.maxDuration, '10m'),
      };

    case 'per-vu-iterations':
      return {
        executor: 'per-vu-iterations',
        vus: Number(profile.vus || 10),
        iterations: Number(profile.iterations || 10),
        maxDuration: toDuration(profile.maxDuration, '10m'),
      };

    case 'ramping-vus':
    default:
      return {
        executor: 'ramping-vus',
        startVUs,
        stages: (profile.stages || []).map((s) => ({
          duration: toDuration(s.duration, '30s'),
          target: Number(s.target || 0),
        })),
        gracefulRampDown: toDuration(profile.gracefulRampDown, '15s'),
        gracefulStop: toDuration(profile.gracefulStop, '30s'),
      };
  }
}

function buildThresholds(profile, requests) {
  const t = {};
  const th = profile.thresholds || {};
  const durParts = [];
  if (th.p95 != null && th.p95 !== '') durParts.push('p(95)<' + Number(th.p95));
  if (th.p99 != null && th.p99 !== '') durParts.push('p(99)<' + Number(th.p99));
  if (th.avg != null && th.avg !== '') durParts.push('avg<' + Number(th.avg));
  if (th.max != null && th.max !== '') durParts.push('max<' + Number(th.max));
  if (durParts.length) t.http_req_duration = durParts;

  if (th.errorRate != null && th.errorRate !== '') {
    t.http_req_failed = ['rate<' + Number(th.errorRate) / 100];
  }
  if (th.checkRate != null && th.checkRate !== '') {
    t.checks = ['rate>' + Number(th.checkRate) / 100];
  }
  if (th.minRps != null && th.minRps !== '') {
    t.http_reqs = ['rate>' + Number(th.minRps)];
  }

  // Per-endpoint SLA overrides, expressed against the custom trend metrics.
  for (const r of requests) {
    if (r.p95 != null && r.p95 !== '') {
      t['ep_' + r.id + '_duration'] = ['p(95)<' + Number(r.p95)];
    }
  }
  return t;
}

function buildOptions(profile, requests, usePerEndpoint) {
  // Per-endpoint thresholds may only reference metrics the script actually creates.
  const thresholdRequests = usePerEndpoint ? requests : [];
  const opts = {
    scenarios: { [profile.scenarioName || 'load']: Object.assign(buildScenario(profile), { exec: 'default' }) },
    thresholds: buildThresholds(profile, thresholdRequests),
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    noConnectionReuse: !!profile.noConnectionReuse,
    insecureSkipTLSVerify: profile.insecureSkipTLSVerify !== false,
    userAgent: profile.userAgent || 'k6-load-lab/1.0',
  };
  if (profile.rpsLimit) opts.rps = Number(profile.rpsLimit);
  if (profile.maxRedirects != null && profile.maxRedirects !== '') opts.maxRedirects = Number(profile.maxRedirects);
  if (profile.discardResponseBodies) opts.discardResponseBodies = true;
  if (profile.tags && Object.keys(profile.tags).length) opts.tags = profile.tags;
  return opts;
}

/**
 * @param {object} spec
 * @param {Array}  spec.requests  normalised requests (enabled ones only)
 * @param {object} spec.variables key/value seed variables
 * @param {object} spec.profile   load profile
 * @returns {string} k6 script source
 */
function generateScript(spec) {
  const requests = (spec.requests || []).filter((r) => r.enabled !== false);
  if (!requests.length) throw new Error('No enabled requests to run');

  const profile = spec.profile || {};
  const variables = spec.variables || {};
  const usePerEndpoint =
    profile.perEndpointMetrics !== false && requests.length <= MAX_PER_ENDPOINT_METRICS;

  const flow = profile.flow || 'sequence';
  const thinkMin = Number(profile.thinkTimeMin != null ? profile.thinkTimeMin : 0.5);
  const thinkMax = Number(profile.thinkTimeMax != null ? profile.thinkTimeMax : 1.5);
  const timeout = toDuration(profile.requestTimeout, '60s');

  const options = buildOptions(profile, requests, usePerEndpoint);

  return `// ---------------------------------------------------------------------------
// Generated by k6 Load Lab on ${new Date().toISOString()}
// Test: ${(profile.name || 'load test').replace(/[\r\n]/g, ' ')}
// Run standalone with:  k6 run script.js
// ---------------------------------------------------------------------------
import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import encoding from 'k6/encoding';
import exec from 'k6/execution';

export const options = ${jsLiteral(options)};

const REQUESTS = ${jsLiteral(requests)};
const SEED_VARS = ${jsLiteral(variables)};
const FLOW = ${JSON.stringify(flow)};
const THINK = { min: ${thinkMin}, max: ${thinkMax} };
const TIMEOUT = ${JSON.stringify(timeout)};
const PER_ENDPOINT_METRICS = ${usePerEndpoint};
const STOP_ON_ERROR = ${!!profile.stopOnError};

// --- custom metrics ---------------------------------------------------------
// k6 rejects '::' inside check names, so labels are sanitised once up front.
const CHECK_NAMES = {};
for (const r of REQUESTS) {
  CHECK_NAMES[r.id] = (r.name + ' - status ' + (r.expectStatus || '2xx')).replace(/:+/g, '-');
}

const errorCount = new Counter('failed_requests');
const endpointMetrics = {};
if (PER_ENDPOINT_METRICS) {
  for (const r of REQUESTS) {
    endpointMetrics[r.id] = {
      duration: new Trend('ep_' + r.id + '_duration', true),
      errors: new Rate('ep_' + r.id + '_errors'),
      hits: new Counter('ep_' + r.id + '_hits'),
    };
  }
}

// --- variable interpolation -------------------------------------------------
const DYNAMIC = {
  $guid: () => uuid(),
  $randomUUID: () => uuid(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1000)),
  $randomFirstName: () => pick(['Ada', 'Grace', 'Alan', 'Linus', 'Rin', 'Noor', 'Ivan', 'Mei']),
  $randomEmail: () => 'user' + Math.floor(Math.random() * 1e9) + '@example.com',
  $vu: () => String(exec.vu.idInTest),
  $iter: () => String(exec.scenario.iterationInTest),
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function interpolate(str, ctx) {
  if (typeof str !== 'string' || str.indexOf('{{') === -1) return str;
  return str.replace(/\\{\\{([^}\\s]+)\\}\\}/g, (match, key) => {
    if (DYNAMIC[key]) return DYNAMIC[key]();
    const value = ctx[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function interpolateDeep(value, ctx) {
  if (typeof value === 'string') return interpolate(value, ctx);
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[interpolate(k, ctx)] = interpolateDeep(value[k], ctx);
    return out;
  }
  return value;
}

// --- request building -------------------------------------------------------
function applyAuth(auth, headers, url, ctx) {
  if (!auth) return url;
  if (auth.type === 'bearer') {
    const token = interpolate(auth.token, ctx);
    if (token) headers.Authorization = 'Bearer ' + token;
  } else if (auth.type === 'basic') {
    const user = interpolate(auth.username, ctx);
    const pass = interpolate(auth.password, ctx);
    headers.Authorization = 'Basic ' + encoding.b64encode(user + ':' + pass);
  } else if (auth.type === 'apikey') {
    const key = interpolate(auth.key, ctx);
    const value = interpolate(auth.value, ctx);
    if (auth.in === 'query') {
      url += (url.indexOf('?') === -1 ? '?' : '&') + encodeURIComponent(key) + '=' + encodeURIComponent(value);
    } else {
      headers[key] = value;
    }
  }
  return url;
}

function buildBody(req, headers, ctx) {
  const body = req.body;
  if (!body) return null;
  switch (body.mode) {
    case 'raw': {
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = body.language === 'json' ? 'application/json' : 'text/plain';
      }
      return interpolate(body.raw, ctx);
    }
    case 'urlencoded': {
      const form = {};
      for (const f of body.fields || []) form[interpolate(f.key, ctx)] = interpolate(f.value, ctx);
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      return form;
    }
    case 'formdata': {
      const form = {};
      for (const f of body.fields || []) {
        if (f.type === 'file') continue; // file uploads need a local fixture; skipped
        form[interpolate(f.key, ctx)] = interpolate(f.value, ctx);
      }
      return form;
    }
    case 'graphql': {
      headers['Content-Type'] = 'application/json';
      return JSON.stringify({
        query: interpolate(body.query, ctx),
        variables: interpolateDeep(body.variables || {}, ctx),
      });
    }
    default:
      return null;
  }
}

function statusMatches(status, expect) {
  const rule = String(expect || '2xx').trim();
  if (rule === '2xx' || rule === '') return status >= 200 && status < 300;
  if (rule === '3xx') return status >= 300 && status < 400;
  if (rule === 'any') return status > 0;
  return rule
    .split(',')
    .map((s) => s.trim())
    .some((s) => String(status) === s);
}

function readJsonPath(res, path) {
  try {
    if (!path) return res.json();
    return res.json(path);
  } catch (e) {
    return undefined;
  }
}

function applyCaptures(req, res, ctx) {
  for (const cap of req.captures || []) {
    let value;
    if (cap.from === 'header') {
      value = res.headers[cap.path] || res.headers[String(cap.path).toLowerCase()];
    } else if (cap.from === 'regex') {
      const m = new RegExp(cap.path).exec(res.body || '');
      value = m ? m[1] || m[0] : undefined;
    } else {
      value = readJsonPath(res, cap.path);
    }
    if (value !== undefined && value !== null) ctx[cap.as] = value;
  }
}

function runRequest(req, ctx) {
  const headers = interpolateDeep(req.headers || {}, ctx);
  let url = interpolate(req.url, ctx);
  url = applyAuth(req.auth, headers, url, ctx);
  const body = buildBody(req, headers, ctx);

  const params = {
    headers,
    timeout: TIMEOUT,
    tags: { name: req.name, endpoint: req.id, method: req.method },
    redirects: ${profile.maxRedirects != null && profile.maxRedirects !== '' ? Number(profile.maxRedirects) : 10},
  };

  const res = http.request(req.method, url, body, params);
  const passed = statusMatches(res.status, req.expectStatus);

  if (PER_ENDPOINT_METRICS && endpointMetrics[req.id]) {
    endpointMetrics[req.id].duration.add(res.timings.duration);
    endpointMetrics[req.id].errors.add(!passed);
    endpointMetrics[req.id].hits.add(1);
  }
  if (!passed) {
    errorCount.add(1, { endpoint: req.id, status: String(res.status) });
  } else {
    applyCaptures(req, res, ctx);
  }

  check(res, { [CHECK_NAMES[req.id]]: () => passed }, { endpoint: req.id });
  return { res, passed };
}

function thinkTime() {
  if (THINK.max <= 0) return;
  sleep(THINK.min + Math.random() * Math.max(0, THINK.max - THINK.min));
}

function weightedPick(list) {
  let total = 0;
  for (const r of list) total += Number(r.weight || 1);
  let n = Math.random() * total;
  for (const r of list) {
    n -= Number(r.weight || 1);
    if (n <= 0) return r;
  }
  return list[list.length - 1];
}

// --- entry point ------------------------------------------------------------
export default function () {
  const ctx = Object.assign({}, SEED_VARS);

  if (FLOW === 'random') {
    const req = weightedPick(REQUESTS);
    const out = runRequest(req, ctx);
    if (!out.passed && STOP_ON_ERROR) fail(req.name + ' failed with status ' + out.res.status);
    thinkTime();
    return;
  }

  // 'sequence': every VU walks the whole journey, carrying captured variables.
  for (const req of REQUESTS) {
    const out = runRequest(req, ctx);
    if (!out.passed && STOP_ON_ERROR) {
      fail(req.name + ' failed with status ' + out.res.status);
    }
    thinkTime();
  }
}
`;
}

module.exports = { generateScript, buildScenario, buildThresholds, toDuration };
