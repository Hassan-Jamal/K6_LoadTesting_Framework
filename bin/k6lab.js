#!/usr/bin/env node
'use strict';
/**
 * k6lab - run a Postman collection as a k6 load test from the terminal.
 *
 *   k6lab run postman_collection.json --base-url https://api.example.com --token abc
 *   k6lab ui
 *   k6lab init
 *   k6lab list
 *   k6lab report <run-id>
 */

const fs = require('fs');
const path = require('path');

const { buildSpec } = require('../server/spec');
const { Runner } = require('../server/runner');
const { Store } = require('../server/store');
const { buildReport } = require('../server/report');
const { PRESETS } = require('../server/presets');
const { openInBrowser } = require('../server/open');

const ROOT = path.join(__dirname, '..');

/**
 * Runs are written next to wherever you invoked the command, so dropping a
 * collection in a folder and running k6lab leaves the reports right there.
 */
function resolveDataDir(flags, cwd) {
  if (flags && flags.out) return path.resolve(cwd, flags.out);
  if (process.env.K6LAB_DATA) return path.resolve(cwd, process.env.K6LAB_DATA);
  return path.join(cwd, 'k6lab-runs');
}

// --- terminal helpers -------------------------------------------------------

const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: useColour ? '\u001b[0m' : '',
  bold: useColour ? '\u001b[1m' : '',
  dim: useColour ? '\u001b[2m' : '',
  red: useColour ? '\u001b[31m' : '',
  green: useColour ? '\u001b[32m' : '',
  yellow: useColour ? '\u001b[33m' : '',
  blue: useColour ? '\u001b[34m' : '',
  magenta: useColour ? '\u001b[35m' : '',
  cyan: useColour ? '\u001b[36m' : '',
  grey: useColour ? '\u001b[90m' : '',
};

const out = (line) => process.stdout.write((line == null ? '' : line) + '\n');

function heading(text) {
  out('');
  out(c.bold + text + c.reset);
  out(c.grey + '─'.repeat(Math.max(text.length, 60)) + c.reset);
}

function fmt(value, digits) {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: digits || 0,
    maximumFractionDigits: digits || 0,
  });
}

function ms(value) {
  const n = Number(value || 0);
  return n >= 1000 ? (n / 1000).toFixed(2) + 's' : n.toFixed(0) + 'ms';
}

function bytes(value) {
  let v = Number(value || 0);
  const units = ['B', 'kB', 'MB', 'GB'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(i ? 1 : 0) + ' ' + units[i];
}

function clock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

/** Fixed-width table so the terminal output stays readable. `headers` may be null. */
function table(headers, rows, aligns) {
  if (!rows.length) return;
  const columns = headers || rows[0].map(() => '');
  const widths = columns.map((h, i) =>
    Math.max(String(h).length, ...rows.map((r) => String(r[i] == null ? '' : r[i]).length))
  );
  const line = (cells, colour) =>
    out(
      '  ' +
        cells
          .map((cell, i) => {
            const text = String(cell == null ? '' : cell);
            return (aligns && aligns[i] === 'r')
              ? text.padStart(widths[i])
              : text.padEnd(widths[i]);
          })
          .join('  ')
          .replace(/\s+$/, '')
          .replace(/^/, colour || '') + c.reset
    );
  if (headers) line(headers, c.grey);
  rows.forEach((row) => line(row));
}

// --- argument parsing -------------------------------------------------------

const FLAG_ALIASES = { u: 'vus', d: 'duration', o: 'out', h: 'help', v: 'version' };

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      let [name, value] = arg.slice(2).split(/=(.+)/);
      const negated = name.startsWith('no-');
      if (negated) name = name.slice(3);
      if (value === undefined) {
        const next = argv[i + 1];
        if (!negated && next !== undefined && !next.startsWith('-')) {
          value = next;
          i++;
        } else {
          value = negated ? 'false' : 'true';
        }
      }
      const key = camel(name);
      if (key === 'var') {
        flags.var = flags.var || [];
        flags.var.push(value);
      } else {
        flags[key] = value;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const key = FLAG_ALIASES[arg.slice(1)] || camel(arg.slice(1));
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function camel(text) {
  return String(text).replace(/-([a-z])/g, (m, ch) => ch.toUpperCase());
}

function bool(value, fallback) {
  if (value === undefined) return fallback;
  return value !== 'false' && value !== false && value !== '0';
}

function num(value) {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Maps CLI flags onto the config shape spec.js understands. */
function overridesFromFlags(flags) {
  const overrides = {};
  const copy = (flag, key, cast) => {
    if (flags[flag] === undefined) return;
    const value = cast ? cast(flags[flag]) : flags[flag];
    if (value !== undefined) overrides[key || flag] = value;
  };

  copy('name');
  copy('baseUrl');
  copy('token');
  copy('environment');
  copy('preset');
  copy('executor');
  copy('stages');
  copy('vus', 'vus', num);
  copy('rate', 'rate', num);
  copy('startRate', 'startRate', num);
  copy('duration');
  copy('iterations', 'iterations', num);
  copy('preAllocatedVus', 'preAllocatedVUs', num);
  copy('maxVus', 'maxVUs', num);
  copy('flow');
  copy('think');
  copy('timeout', 'requestTimeout');
  copy('rps', 'rpsLimit', num);
  copy('include');
  copy('exclude');
  copy('onlyMethods');

  if (flags.safe !== undefined) overrides.safe = bool(flags.safe, false);
  if (flags.stopOnError !== undefined) overrides.stopOnError = bool(flags.stopOnError, false);
  if (flags.connectionReuse !== undefined) overrides.noConnectionReuse = !bool(flags.connectionReuse, true);
  if (flags.insecure !== undefined) overrides.insecureSkipTLSVerify = bool(flags.insecure, true);
  if (flags.executor !== undefined) overrides.executorExplicit = true;

  const thresholds = {};
  if (flags.p95 !== undefined) thresholds.p95 = num(flags.p95);
  if (flags.p99 !== undefined) thresholds.p99 = num(flags.p99);
  if (flags.errorRate !== undefined) thresholds.errorRate = num(flags.errorRate);
  if (flags.checkRate !== undefined) thresholds.checkRate = num(flags.checkRate);
  if (Object.keys(thresholds).length) overrides.thresholds = thresholds;

  if (flags.var) {
    overrides.variables = {};
    for (const pair of flags.var) {
      const idx = String(pair).indexOf('=');
      if (idx < 0) throw new Error('--var needs name=value, got "' + pair + '"');
      overrides.variables[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
  }
  return overrides;
}

// --- commands ---------------------------------------------------------------

const HELP = `
${c.bold}k6lab${c.reset} - run a Postman collection as a k6 load test

${c.bold}USAGE${c.reset}
  k6lab run [collection.json] [options]   run a load test and write a report
  k6lab ui [--port 4300]                  open the web console in your browser
  k6lab init                              write a k6lab.config.json template here
  k6lab list                              list previous runs
  k6lab report [run-id]                   open a run's HTML report
  k6lab presets                           show the built-in load shapes
  k6lab doctor                            check this machine and folder are ready

${c.bold}TARGET${c.reset}
  --base-url <url>        override {{baseUrl}} in the collection
  --token <jwt>           override {{token}} (bearer auth)
  --var name=value        set any {{variable}} (repeatable)
  --environment <file>    a Postman environment export
  --config <file>         config file (default: ./k6lab.config.json)

${c.bold}LOAD SHAPE${c.reset}
  --preset <name>         smoke | average | stress | spike | soak | breakpoint
  --stages 30s:20,1m:20,30s:0    explicit ramp (duration:target, comma separated)
  --vus <n>               virtual users (non-staged executors)
  --duration <5m>         test length (non-staged executors)
  --executor <name>       ramping-vus | constant-vus | ramping-arrival-rate |
                          constant-arrival-rate | shared-iterations | per-vu-iterations
  --rate <n>              requests/sec for arrival-rate executors
  --max-vus <n>           VU ceiling for arrival-rate executors
  --rps <n>               global requests/sec cap (0 = off)
  --think 0.5-1.5         think time range in seconds between requests
  --flow sequence|random  walk every request per iteration, or pick one

${c.bold}WHICH REQUESTS${c.reset}
  --safe                  read-only endpoints only (GET/HEAD/OPTIONS)
  --only-methods GET,POST limit to these HTTP methods
  --include <regex>       keep requests matching name/url/folder
  --exclude <regex>       drop requests matching name/url/folder

${c.bold}PASS / FAIL${c.reset}
  --p95 <ms>              fail if p95 latency exceeds this (default 800)
  --p99 <ms>              fail if p99 latency exceeds this
  --error-rate <pct>      fail above this error percentage (default 1)
  --check-rate <pct>      fail below this check success rate (default 99)

${c.bold}OUTPUT${c.reset}
  --open                  open the HTML report when the run finishes
  --quiet                 only print the final summary
  --dry-run               show what would run, then stop
  --print-script          print the generated k6 script and stop
  --yes                   skip the confirmation prompt for write/delete endpoints

${c.bold}EXAMPLES${c.reset}
  ${c.grey}# smoke test everything read-only, then open the report${c.reset}
  k6lab run postman_collection.json --base-url https://api.acme.com --token eyJ... \\
        --preset smoke --safe --open

  ${c.grey}# 20 users for 5 minutes, fail the build if p95 goes over 500ms${c.reset}
  k6lab run --stages 1m:20,3m:20,1m:0 --p95 500 --error-rate 0.5

  ${c.grey}# find the breaking point on throughput${c.reset}
  k6lab run --preset breakpoint --safe
`;

function resolveK6Path() {
  return process.env.K6_PATH || 'k6';
}

function ensureK6() {
  const { spawnSync } = require('child_process');
  const result = spawnSync(resolveK6Path(), ['version'], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    out('');
    out(c.red + 'k6 was not found.' + c.reset);
    out('');
    out('  Install it with one of:');
    out('    ' + c.cyan + 'winget install k6 --source winget' + c.reset + '   (Windows)');
    out('    ' + c.cyan + 'brew install k6' + c.reset + '                     (macOS)');
    out('    ' + c.cyan + 'choco install k6' + c.reset + '                    (Windows, Chocolatey)');
    out('  or download it from https://github.com/grafana/k6/releases');
    out('');
    out('  Already installed somewhere else? Point at it:');
    out('    ' + c.cyan + 'K6_PATH="C:\\tools\\k6.exe" k6lab run' + c.reset);
    out('');
    process.exit(127);
  }
  return String(result.stdout).trim();
}

async function confirm(question) {
  if (!process.stdin.isTTY) return true; // non-interactive (CI): assume intent
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(String(answer).trim());
}

async function commandRun(positional, flags) {
  const cwd = process.cwd();
  const k6Version = ensureK6();

  const built = buildSpec({
    cwd,
    collectionPath: positional[0],
    configPath: flags.config,
    overrides: overridesFromFlags(flags),
  });

  const { spec, allRequests, collection, collectionPath, configFile, warnings } = built;
  const quiet = bool(flags.quiet, false);

  if (!quiet) {
    heading('k6 Load Lab');
    out('  collection   ' + c.cyan + path.relative(cwd, collectionPath) + c.reset +
        c.grey + '  (' + collection.requests.length + ' endpoints)' + c.reset);
    if (configFile) out('  config       ' + c.grey + path.relative(cwd, configFile) + c.reset);
    out('  k6           ' + c.grey + k6Version + c.reset);
    out('  test         ' + spec.profile.name);
    out('  shape        ' + describeProfile(spec.profile));
    out('  selected     ' + spec.requests.length + ' of ' + allRequests.length + ' requests');

    const shownVars = Object.entries(spec.variables).slice(0, 8);
    if (shownVars.length) {
      out('  variables    ' + shownVars.map(([k, v]) => k + '=' + maskValue(k, v)).join('  '));
    }
  }

  if (flags.printScript !== undefined) {
    const { generateScript } = require('../server/generator');
    out(generateScript(spec));
    return 0;
  }

  if (!quiet && spec.requests.length) {
    heading('Requests to be called');
    table(
      ['METHOD', 'NAME', 'URL'],
      spec.requests.slice(0, 25).map((r) => [r.method, truncate(r.name, 38), truncate(r.url, 60)])
    );
    if (spec.requests.length > 25) out(c.grey + '  ... and ' + (spec.requests.length - 25) + ' more' + c.reset);
  }

  let blocking = false;
  if (warnings.length) {
    heading('Before you run');
    for (const warning of warnings) {
      const tag = warning.level === 'error' ? c.red + '  ✗ ' : c.yellow + '  ! ';
      out(tag + warning.message.split('\n').join('\n    ') + c.reset);
      if (warning.level === 'error') blocking = true;
    }
  }

  if (flags.dryRun !== undefined) {
    out('');
    out(c.grey + '  --dry-run: stopping here.' + c.reset);
    return blocking ? 1 : 0;
  }

  if (blocking) {
    out('');
    out(c.red + '  Not starting: the run would send empty or placeholder values.' + c.reset);
    out('  Fix the values above, or pass --yes to run anyway.');
    if (!bool(flags.yes, false)) return 1;
  }

  const needsConfirm =
    !bool(flags.yes, false) &&
    warnings.some((w) => w.level === 'warn') &&
    process.stdin.isTTY;
  if (needsConfirm) {
    out('');
    const ok = await confirm(c.yellow + '  Continue? [y/N] ' + c.reset);
    if (!ok) {
      out('  Cancelled.');
      return 130;
    }
  }

  // --- run ---
  const dataDir = resolveDataDir(flags, cwd);
  fs.mkdirSync(dataDir, { recursive: true });

  const runner = new Runner({
    k6Path: resolveK6Path(),
    dataDir,
    apiPort: Number(process.env.K6_API_PORT || 6565),
    dashboardPort: Number(process.env.K6_DASHBOARD_PORT || 5665),
  });
  const store = new Store(dataDir);

  heading('Running');

  return await new Promise((resolve) => {
    let lastLine = '';
    let stopping = false;

    const onSignal = () => {
      if (stopping) return;
      stopping = true;
      out('');
      out(c.yellow + '  Stopping gracefully so the report is still written...' + c.reset);
      runner.stop().catch(() => {});
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    runner.on('tick', (data) => {
      if (quiet) return;
      const t = data.tick;
      // The tick carries its own offset, so the clock stays monotonic even when
      // a bucket is flushed slightly late.
      const total = data.plannedDuration
        ? clock(t.elapsed) + c.grey + '/' + clock(data.plannedDuration) + c.reset
        : clock(t.elapsed);
      const errColour = t.errorRate > 0 ? c.red : c.green;
      lastLine =
        '  ' + total +
        '   ' + c.magenta + 'VUs ' + String(t.vus).padStart(4) + c.reset +
        '   ' + c.blue + 'rps ' + String(Math.round(t.rps)).padStart(5) + c.reset +
        '   p95 ' + String(ms(t.p95)).padStart(7) +
        '   ' + errColour + 'err ' + t.errorRate.toFixed(1).padStart(5) + '%' + c.reset +
        '   ' + c.grey + fmt(data.totals.requests) + ' reqs' + c.reset;
      if (process.stdout.isTTY) {
        process.stdout.write('\r' + ' '.repeat(Math.min(120, process.stdout.columns || 120)) + '\r');
        process.stdout.write(lastLine);
      } else {
        out(lastLine);
      }
    });

    runner.on('log', (entry) => {
      if (entry.level !== 'error') return;
      const message = entry.message.replace(/^time="[^"]*"\s*/, '').replace(/\s+source=stacktrace.*$/, '');
      if (process.stdout.isTTY && lastLine) out('');
      out(c.red + '  k6: ' + truncate(message, 160) + c.reset);
    });

    runner.on('end', (result) => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      if (process.stdout.isTTY && lastLine) out('');

      const reportPath = path.join(store.runDir(result.id), 'report.html');
      try {
        fs.writeFileSync(reportPath, buildReport(Object.assign({ id: result.id }, result)), 'utf8');
      } catch (err) {
        out(c.red + '  Could not write the report: ' + err.message + c.reset);
      }

      printSummary(result, reportPath, store, cwd);

      if (bool(flags.open, false)) openInBrowser('file://' + reportPath.replace(/\\/g, '/'));

      const breaches = (result.thresholds || []).filter((t) => !t.passed).length;
      const noTraffic = !(result.totals && result.totals.requests);
      resolve(result.status === 'failed' || breaches || noTraffic ? 1 : 0);
    });

    runner.start(spec)
      .then((state) => {
        if (!quiet) {
          out(c.grey + '  live k6 dashboard: ' + state.dashboardUrl + '   (Ctrl+C stops the test)' + c.reset);
          out('');
        }
      })
      .catch((err) => {
      out(c.red + '  Could not start k6: ' + err.message + c.reset);
      resolve(1);
    });
  });
}

function printSummary(result, reportPath, store, cwd) {
  const totals = result.totals || {};
  const breaches = (result.thresholds || []).filter((t) => !t.passed);

  heading('Result');
  // Thresholds pass vacuously when nothing was sent, so no traffic is its own
  // verdict rather than a green tick.
  const noTraffic = !totals.requests;
  const verdict = noTraffic
    ? c.red + 'NO TRAFFIC' + c.reset
    : result.status === 'passed' && !breaches.length
    ? c.green + 'PASSED' + c.reset
    : result.status === 'stopped'
    ? c.yellow + 'STOPPED' + c.reset
    : c.red + 'FAILED' + c.reset;
  out('  ' + verdict + '   ' + c.grey + result.name + ' · ran ' + clock(result.duration) + c.reset);
  if (noTraffic) {
    out('');
    out('  ' + c.red + 'Not one request was sent, so these numbers mean nothing.' + c.reset);
    out('  ' + c.grey + 'Usually: the ramp never reached a whole VU (try --preset smoke or a' + c.reset);
    out('  ' + c.grey + 'longer first stage), every request was filtered out, or k6 failed to' + c.reset);
    out('  ' + c.grey + 'start - check the k6 errors above.' + c.reset);
  }
  out('');

  table(
    null,
    [
      ['requests', fmt(totals.requests) + '   ' + c.grey + fmt(totals.avgRps, 1) + '/s avg, ' + fmt(totals.peakRps) + '/s peak' + c.reset],
      ['iterations', fmt(totals.iterations)],
      ['peak VUs', fmt(totals.peakVus)],
      ['failed', fmt(totals.failed) + '   ' + (totals.errorRate > 0 ? c.red : c.green) + fmt(totals.errorRate, 2) + '%' + c.reset],
      ['checks', fmt(totals.checksPassed) + ' / ' + fmt(totals.checksPassed + totals.checksFailed)],
      ['latency', 'avg ' + ms(totals.avg) + '   p90 ' + ms(totals.p90) + '   p95 ' + ms(totals.p95) + '   p99 ' + ms(totals.p99) + '   max ' + ms(totals.max)],
      ['data', bytes(totals.dataReceived) + ' in, ' + bytes(totals.dataSent) + ' out'],
    ].concat(totals.droppedIterations ? [['dropped', c.yellow + fmt(totals.droppedIterations) + ' iterations' + c.reset]] : [])
  );

  if ((result.thresholds || []).length) {
    heading('Thresholds');
    table(
      ['METRIC', 'RULE', 'ACTUAL', ''],
      result.thresholds.map((t) => [
        t.metric,
        t.expression,
        t.actual == null ? '-' : fmt(t.actual, 2),
        t.passed ? c.green + 'pass' + c.reset : c.red + 'FAIL' + c.reset,
      ]),
      ['l', 'l', 'r', 'l']
    );
  }

  if ((result.endpoints || []).length) {
    heading('Endpoints');
    table(
      ['ENDPOINT', 'REQS', 'ERR%', 'AVG', 'P95', 'P99', 'MAX'],
      result.endpoints.slice(0, 20).map((e) => [
        truncate(e.name, 44),
        fmt(e.requests),
        (e.errorRate > 0 ? c.red : '') + fmt(e.errorRate, 1) + c.reset,
        ms(e.avg),
        ms(e.p95),
        ms(e.p99),
        ms(e.max),
      ]),
      ['l', 'r', 'r', 'r', 'r', 'r', 'r']
    );
  }

  const errors = (result.errors || []).slice().sort((a, b) => b.count - a.count).slice(0, 10);
  if (errors.length) {
    heading('Failures');
    table(
      ['ENDPOINT', 'STATUS', 'ERROR', 'COUNT'],
      errors.map((e) => [truncate(e.endpoint, 44), e.status, e.errorCode || '-', fmt(e.count)]),
      ['l', 'l', 'l', 'r']
    );
  }

  heading('Report');
  out('  ' + c.cyan + reportPath + c.reset);
  const k6Report = store.k6ReportPath(result.id);
  if (fs.existsSync(k6Report)) out('  ' + c.grey + k6Report + '  (k6 native dashboard)' + c.reset);
  out('  ' + c.grey + store.scriptPath(result.id) + '  (re-run with: k6 run script.js)' + c.reset);
  out('');
  out(c.grey + '  Open it with: ' + c.reset + 'k6lab report ' + result.id + c.grey + '   or add --open next time.' + c.reset);
  out('');
}

function describeProfile(profile) {
  if (profile.stages && profile.stages.length && profile.executor.indexOf('ramping') === 0) {
    const unit = profile.executor === 'ramping-arrival-rate' ? ' req/s' : ' VUs';
    return profile.executor + '  ' + profile.stages.map((s) => s.duration + '→' + s.target + unit).join(', ');
  }
  if (profile.executor.indexOf('arrival-rate') >= 0) {
    return profile.executor + '  ' + profile.rate + ' req/s for ' + profile.duration;
  }
  if (profile.executor.indexOf('iterations') >= 0) {
    return profile.executor + '  ' + profile.iterations + ' iterations, ' + profile.vus + ' VUs';
  }
  return profile.executor + '  ' + profile.vus + ' VUs for ' + profile.duration;
}

function maskValue(key, value) {
  const text = String(value == null ? '' : value);
  if (!text) return c.red + '(empty)' + c.reset;
  if (/token|secret|password|key|auth/i.test(key)) {
    return c.grey + (text.length > 12 ? text.slice(0, 6) + '…' + text.slice(-4) : '••••') + c.reset;
  }
  return c.grey + truncate(text, 34) + c.reset;
}

function truncate(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function commandInit() {
  const target = path.join(process.cwd(), 'k6lab.config.json');
  if (fs.existsSync(target)) {
    out(c.yellow + 'k6lab.config.json already exists here.' + c.reset);
    return 1;
  }
  const template = {
    $schema: 'https://k6lab.local/config',
    collection: 'postman_collection.json',
    name: 'My API load test',
    baseUrl: 'https://api.example.com',
    variables: {
      token: 'PASTE_YOUR_BEARER_TOKEN_HERE',
      id: '',
    },
    preset: 'average',
    flow: 'sequence',
    think: [0.5, 1.5],
    safe: true,
    thresholds: { p95: 800, errorRate: 1, checkRate: 99 },
  };
  fs.writeFileSync(target, JSON.stringify(template, null, 2) + '\n', 'utf8');
  out(c.green + 'Created ' + target + c.reset);
  out('');
  out('  1. Put your postman_collection.json in this folder');
  out('  2. Fill in baseUrl and variables (token, ids)');
  out('  3. ' + c.cyan + 'k6lab run --open' + c.reset);
  out('');
  return 0;
}

function commandList(flags) {
  const dataDir = resolveDataDir(flags, process.cwd());
  const runs = new Store(dataDir).list();
  if (!runs.length) {
    out('No runs yet. Try: ' + c.cyan + 'k6lab run' + c.reset);
    return 0;
  }
  heading('Runs');
  table(
    ['RUN ID', 'STATUS', 'TEST', 'STARTED', 'REQS', 'ERR%', 'P95'],
    runs.map((r) => [
      r.id,
      r.status === 'passed' ? c.green + 'passed' + c.reset : r.status === 'failed' ? c.red + 'failed' + c.reset : c.yellow + r.status + c.reset,
      truncate(r.name, 30),
      r.startedAt ? new Date(r.startedAt).toLocaleString() : '-',
      fmt(r.totals && r.totals.requests),
      fmt(r.totals && r.totals.errorRate, 2),
      ms(r.totals && r.totals.p95),
    ]),
    ['l', 'l', 'l', 'l', 'r', 'r', 'r']
  );
  out('');
  return 0;
}

function commandReport(positional, flags) {
  const dataDir = resolveDataDir(flags, process.cwd());
  const store = new Store(dataDir);
  const runs = store.list();
  if (!runs.length) {
    out('No runs to report on yet.');
    return 1;
  }
  const id = positional[0] || runs[0].id;
  const run = store.get(id);
  if (!run) {
    out(c.red + 'No run with id ' + id + c.reset);
    return 1;
  }
  const reportPath = path.join(store.runDir(id), 'report.html');
  if (!fs.existsSync(reportPath)) {
    fs.writeFileSync(reportPath, buildReport(run), 'utf8');
  }
  out('Opening ' + c.cyan + reportPath + c.reset);
  openInBrowser('file://' + reportPath.replace(/\\/g, '/'));
  return 0;
}

/** Environment check - the first thing to run when a fresh setup misbehaves. */
function commandDoctor() {
  const { spawnSync } = require('child_process');
  const cwd = process.cwd();
  let problems = 0;

  const check = (label, ok, detail, fix) => {
    const mark = ok ? c.green + '✓' + c.reset : c.red + '✗' + c.reset;
    out('  ' + mark + '  ' + label.padEnd(22) + (detail || ''));
    if (!ok) {
      problems++;
      if (fix) out('     ' + c.grey + fix + c.reset);
    }
  };

  heading('Environment');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  check('node', nodeMajor >= 18, 'v' + process.versions.node, 'k6lab needs Node 18 or newer.');

  const k6 = spawnSync(resolveK6Path(), ['version'], { encoding: 'utf8', windowsHide: true });
  const k6Ok = !k6.error && k6.status === 0;
  check(
    'k6',
    k6Ok,
    k6Ok ? String(k6.stdout).trim() : 'not found on PATH',
    'Install it: winget install k6 --source winget  |  brew install k6\n' +
      '     Or point at an existing binary: K6_PATH="C:\\tools\\k6.exe"'
  );

  const chartJs = path.join(ROOT, 'public', 'vendor', 'chart.umd.js');
  check(
    'web console assets',
    fs.existsSync(chartJs),
    fs.existsSync(chartJs) ? 'chart.js vendored' : 'chart.js missing',
    'Run `npm install` in ' + ROOT
  );

  heading('This folder');
  out('  ' + c.grey + cwd + c.reset);

  let collection = null;
  let collectionProblem = null;
  try {
    collection = require('../server/spec').findCollection(cwd);
  } catch (err) {
    collectionProblem = err.message;
  }
  check(
    'collection',
    !!collection,
    collection ? path.basename(collection) : collectionProblem ? 'ambiguous' : 'none found',
    collectionProblem || 'Put a postman_collection.json here, or name one: k6lab run mine.json'
  );

  const configPath = path.join(cwd, 'k6lab.config.json');
  check(
    'config',
    true,
    fs.existsSync(configPath) ? 'k6lab.config.json' : c.grey + 'none (optional - run `k6lab init`)' + c.reset
  );

  const dataDir = resolveDataDir({}, cwd);
  const runCount = fs.existsSync(dataDir)
    ? fs.readdirSync(dataDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length
    : 0;
  check('previous runs', true, runCount + ' in ' + path.relative(cwd, dataDir));

  if (collection) {
    try {
      const built = require('../server/spec').buildSpec({ cwd, collectionPath: collection, overrides: {} });
      heading('Collection');
      out('  ' + built.collection.requests.length + ' endpoints, ' +
          Object.keys(built.spec.variables).length + ' variables');
      const blocking = built.warnings.filter((w) => w.level === 'error');
      if (blocking.length) {
        for (const warning of blocking) out('  ' + c.red + '✗ ' + warning.message.split('\n')[0] + c.reset);
        problems += blocking.length;
      } else {
        out('  ' + c.green + '✓' + c.reset + '  every variable has a value');
      }
    } catch (err) {
      out('  ' + c.red + '✗ could not parse it: ' + err.message + c.reset);
      problems++;
    }
  }

  out('');
  out(problems ? c.red + '  ' + problems + ' thing(s) to fix.' + c.reset : c.green + '  Ready to run.' + c.reset);
  out('');
  return problems ? 1 : 0;
}

function commandPresets() {
  heading('Load presets');
  table(
    ['NAME', 'SHAPE', 'WHAT IT IS FOR'],
    PRESETS.map((p) => [p.key, p.hint, p.description])
  );
  out('');
  out(c.grey + '  Use with: ' + c.reset + 'k6lab run --preset stress');
  out('');
  return 0;
}

function commandUi(flags) {
  ensureK6();
  const port = flags.port || process.env.PORT || 4300;
  process.env.PORT = String(port);
  process.env.K6LAB_OPEN = bool(flags.open, true) ? '1' : '0';
  require('../server/index.js');
  return null; // server keeps running
}

// --- entry ------------------------------------------------------------------

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = (positional.shift() || '').toLowerCase();

  if (flags.version) {
    out(require('../package.json').version);
    return 0;
  }
  if (!command || command === 'help' || flags.help) {
    out(HELP);
    return 0;
  }

  switch (command) {
    case 'run':
      return await commandRun(positional, flags);
    case 'ui':
    case 'serve':
      return commandUi(flags);
    case 'init':
      return commandInit();
    case 'list':
    case 'runs':
      return commandList(flags);
    case 'report':
    case 'open':
      return commandReport(positional, flags);
    case 'doctor':
    case 'check':
      return commandDoctor();
    case 'presets':
      return commandPresets();
    default:
      out(c.red + 'Unknown command "' + command + '"' + c.reset);
      out(HELP);
      return 1;
  }
}

main()
  .then((code) => {
    if (code !== null && code !== undefined) process.exitCode = code;
  })
  .catch((err) => {
    out('');
    out(c.red + (err && err.message ? err.message : String(err)) + c.reset);
    if (process.env.DEBUG) out(err && err.stack);
    process.exitCode = 1;
  });
