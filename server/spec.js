'use strict';
/**
 * Turns "a collection file + some settings" into the run spec the generator
 * and runner expect. Shared by the CLI and the web API so both behave the same.
 */

const fs = require('fs');
const path = require('path');

const { parseCollection } = require('./postman');
const { getPreset } = require('./presets');

const DESTRUCTIVE_METHODS = new Set(['DELETE', 'PUT', 'PATCH', 'POST']);
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const DEFAULT_CONFIG = {
  name: null,
  collection: null,
  environment: null,
  baseUrl: null,
  token: null,
  variables: {},
  preset: null,
  executor: 'ramping-vus',
  stages: null,
  vus: 10,
  rate: 50,
  startRate: 0,
  duration: '1m',
  iterations: 100,
  preAllocatedVUs: 50,
  maxVUs: 200,
  flow: 'sequence',
  think: [0.5, 1.5],
  requestTimeout: '60s',
  rpsLimit: 0,
  stopOnError: false,
  noConnectionReuse: false,
  insecureSkipTLSVerify: true,
  safe: false,
  onlyMethods: null,
  include: null,
  exclude: null,
  thresholds: { p95: 800, p99: '', errorRate: 1, checkRate: 99 },
};

function readJson(file) {
  // Postman exports from Windows often carry a UTF-8 BOM, which JSON.parse rejects.
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

/** Loads k6lab.config.json (or an explicit path) if one exists. */
function loadConfigFile(explicitPath, cwd) {
  const candidate = explicitPath
    ? path.resolve(cwd, explicitPath)
    : path.join(cwd, 'k6lab.config.json');
  if (!fs.existsSync(candidate)) {
    if (explicitPath) throw new Error('Config file not found: ' + candidate);
    return { config: {}, file: null };
  }
  return { config: readJson(candidate), file: candidate };
}

/** Finds a collection file when the user did not name one. */
function findCollection(cwd) {
  const preferred = ['postman_collection.json', 'collection.json'];
  for (const name of preferred) {
    const full = path.join(cwd, name);
    if (fs.existsSync(full)) return full;
  }
  const matches = fs
    .readdirSync(cwd)
    .filter((f) => /\.postman_collection\.json$/i.test(f) || /postman.*\.json$/i.test(f));
  if (matches.length === 1) return path.join(cwd, matches[0]);
  if (matches.length > 1) {
    throw new Error(
      'Several collections found (' + matches.join(', ') + '). Name the one to use, e.g. k6lab run ' + matches[0]
    );
  }
  return null;
}

function normaliseThink(think) {
  if (Array.isArray(think)) return [Number(think[0]) || 0, Number(think[1]) || 0];
  const text = String(think == null ? '' : think).trim();
  if (!text) return [0.5, 1.5];
  const parts = text.split(/[-,:]/).map((p) => parseFloat(p));
  if (parts.length === 1 && Number.isFinite(parts[0])) return [parts[0], parts[0]];
  return [Number.isFinite(parts[0]) ? parts[0] : 0, Number.isFinite(parts[1]) ? parts[1] : 0];
}

/** "30s:10,1m:10,30s:0" -> [{duration,target}] */
function parseStages(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value.map((s) =>
      typeof s === 'string'
        ? { duration: s.split(':')[0], target: Number(s.split(':')[1] || 0) }
        : { duration: String(s.duration), target: Number(s.target || 0) }
    );
  }
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [duration, target] = part.split(':');
      if (!duration || target === undefined) {
        throw new Error('Bad stage "' + part + '". Use duration:target, e.g. 30s:20');
      }
      return { duration: duration.trim(), target: Number(target) };
    });
}

function mergeConfig(fileConfig, overrides) {
  const merged = Object.assign({}, DEFAULT_CONFIG, fileConfig || {});
  merged.variables = Object.assign({}, DEFAULT_CONFIG.variables, (fileConfig || {}).variables);
  merged.thresholds = Object.assign({}, DEFAULT_CONFIG.thresholds, (fileConfig || {}).thresholds);

  for (const [key, value] of Object.entries(overrides || {})) {
    if (value === undefined || value === null) continue;
    if (key === 'variables') {
      Object.assign(merged.variables, value);
    } else if (key === 'thresholds') {
      Object.assign(merged.thresholds, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/** Builds the load profile out of the resolved config. */
function buildProfile(config, collectionName) {
  const preset = config.preset ? getPreset(config.preset) : null;
  if (config.preset && !preset) throw new Error('Unknown preset "' + config.preset + '"');

  const profile = Object.assign(
    {
      name: config.name || collectionName || 'Load test',
      executor: config.executor,
      stages: parseStages(config.stages),
      vus: Number(config.vus),
      rate: Number(config.rate),
      startRate: Number(config.startRate),
      duration: config.duration,
      iterations: Number(config.iterations),
      preAllocatedVUs: Number(config.preAllocatedVUs),
      maxVUs: Number(config.maxVUs),
      flow: config.flow,
      requestTimeout: config.requestTimeout,
      rpsLimit: Number(config.rpsLimit) || 0,
      stopOnError: !!config.stopOnError,
      noConnectionReuse: !!config.noConnectionReuse,
      insecureSkipTLSVerify: config.insecureSkipTLSVerify !== false,
      thresholds: config.thresholds,
    },
    preset ? preset.profile : {}
  );

  // Explicit stages / executor always beat the preset's shape.
  const explicitStages = parseStages(config.stages);
  if (explicitStages) {
    profile.stages = explicitStages;
    if (!config.executorExplicit && profile.executor.indexOf('ramping') !== 0) {
      profile.executor = 'ramping-vus';
    }
  }
  if (config.executorExplicit) profile.executor = config.executor;
  if (!profile.stages) profile.stages = DEFAULT_STAGES.slice();

  const think = normaliseThink(config.think);
  profile.thinkTimeMin = think[0];
  profile.thinkTimeMax = think[1];
  profile.name = config.name || profile.name;
  return profile;
}

const DEFAULT_STAGES = [
  { duration: '30s', target: 10 },
  { duration: '1m', target: 10 },
  { duration: '30s', target: 0 },
];

function matches(pattern, request) {
  if (!pattern) return false;
  const re = new RegExp(pattern, 'i');
  return re.test(request.name) || re.test(request.url) || re.test(request.folder || '');
}

/** Applies the method / include / exclude filters to the request list. */
function filterRequests(requests, config) {
  let allowed = null;
  if (config.safe) allowed = READ_ONLY_METHODS;
  if (config.onlyMethods) {
    const list = Array.isArray(config.onlyMethods)
      ? config.onlyMethods
      : String(config.onlyMethods).split(',');
    allowed = new Set(list.map((m) => m.trim().toUpperCase()).filter(Boolean));
  }

  return requests.map((request) => {
    let enabled = request.enabled !== false;
    if (enabled && allowed && !allowed.has(request.method)) enabled = false;
    if (enabled && config.include && !matches(config.include, request)) enabled = false;
    if (enabled && config.exclude && matches(config.exclude, request)) enabled = false;
    return Object.assign({}, request, { enabled });
  });
}

/**
 * Resolves a collection plus config into a runnable spec, along with the
 * warnings a caller should show before firing load at a real system.
 */
function buildSpec(options) {
  const cwd = options.cwd || process.cwd();
  const { config: fileConfig, file: configFile } = loadConfigFile(options.configPath, cwd);
  const config = mergeConfig(fileConfig, options.overrides);

  const collectionPath = path.resolve(
    cwd,
    options.collectionPath || config.collection || findCollection(cwd) || ''
  );
  if (!options.collectionPath && !config.collection && !fs.existsSync(collectionPath)) {
    throw new Error(
      'No collection found. Put a postman_collection.json in this folder, or pass one:\n' +
        '  k6lab run path/to/postman_collection.json'
    );
  }
  if (!fs.existsSync(collectionPath)) throw new Error('Collection not found: ' + collectionPath);

  const environment = config.environment
    ? readJson(path.resolve(cwd, config.environment))
    : null;

  const parsed = parseCollection(readJson(collectionPath), environment);

  // Precedence: collection defaults < config.variables < --base-url / --token.
  const variables = Object.assign({}, parsed.variables, config.variables);
  if (config.baseUrl) {
    for (const key of ['baseUrl', 'base_url', 'BASE_URL', 'url', 'host']) {
      if (key in variables) variables[key] = config.baseUrl;
    }
    if (!('baseUrl' in variables) && !('base_url' in variables)) variables.baseUrl = config.baseUrl;
  }
  if (config.token) {
    for (const key of ['token', 'accessToken', 'access_token', 'authToken', 'jwt']) {
      if (key in variables) variables[key] = config.token;
    }
    if (!('token' in variables)) variables.token = config.token;
  }

  const requests = filterRequests(parsed.requests, config);
  const selected = requests.filter((r) => r.enabled);
  const profile = buildProfile(config, parsed.name);

  return {
    spec: { requests: selected, variables, profile },
    allRequests: requests,
    collection: parsed,
    collectionPath,
    configFile,
    config,
    warnings: collectWarnings(selected, variables, config),
  };
}

/** Things worth saying out loud before a run starts. */
function collectWarnings(selected, variables, config) {
  const warnings = [];

  if (!selected.length) {
    warnings.push({
      level: 'error',
      message: 'No requests are selected. Check your --include / --exclude / --only-methods filters.',
    });
    return warnings;
  }

  // Placeholders that are still empty will be substituted with "" at runtime.
  const used = new Set();
  const scan = (text) => {
    if (typeof text !== 'string') return;
    const re = /\{\{([^}\s]+)\}\}/g;
    let m;
    while ((m = re.exec(text))) if (!m[1].startsWith('$')) used.add(m[1]);
  };
  for (const request of selected) {
    scan(request.url);
    Object.entries(request.headers || {}).forEach(([k, v]) => {
      scan(k);
      scan(v);
    });
    if (request.body) scan(JSON.stringify(request.body));
    if (request.auth) scan(JSON.stringify(request.auth));
  }

  const captured = new Set();
  for (const request of selected) for (const c of request.captures || []) captured.add(c.as);

  const empty = [...used].filter((name) => !captured.has(name) && !String(variables[name] || '').trim());
  if (empty.length) {
    warnings.push({
      level: 'error',
      message:
        'These variables have no value and will be sent empty: ' + empty.join(', ') +
        '\n  Set them with --var name=value, or in k6lab.config.json under "variables".',
      variables: empty,
    });
  }

  const placeholderish = Object.entries(variables).filter(
    ([, value]) => /^(PASTE_|CHANGE_?ME|your-api\.example\.com|<.*>)/i.test(String(value || ''))
  );
  if (placeholderish.length) {
    warnings.push({
      level: 'error',
      message:
        'These variables still hold the template placeholder value: ' +
        placeholderish.map(([k]) => k).join(', ') +
        '\n  The requests will not reach a real system until you set them.',
      variables: placeholderish.map(([k]) => k),
    });
  }

  const destructive = selected.filter((r) => DESTRUCTIVE_METHODS.has(r.method) && r.method !== 'POST');
  const writes = selected.filter((r) => r.method === 'POST');
  if (destructive.length && !config.safe) {
    warnings.push({
      level: 'warn',
      message:
        destructive.length + ' selected request(s) use ' +
        [...new Set(destructive.map((r) => r.method))].join('/') +
        ' and will be called repeatedly against the target:\n' +
        destructive.slice(0, 8).map((r) => '    ' + r.method + ' ' + r.url).join('\n') +
        (destructive.length > 8 ? '\n    ... and ' + (destructive.length - 8) + ' more' : '') +
        '\n  Use --safe for read-only endpoints, or --exclude to drop them.',
    });
  } else if (writes.length && !config.safe) {
    warnings.push({
      level: 'warn',
      message: writes.length + ' selected request(s) POST data and will create records on every iteration.',
    });
  }

  return warnings;
}

module.exports = {
  buildSpec,
  mergeConfig,
  loadConfigFile,
  findCollection,
  parseStages,
  normaliseThink,
  filterRequests,
  DEFAULT_CONFIG,
};
