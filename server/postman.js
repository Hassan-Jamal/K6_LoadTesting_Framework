'use strict';
/**
 * Postman collection -> normalised request list.
 * Supports schema v2.0 and v2.1, nested folders, collection/folder/item level
 * auth, all common body modes and Postman environment exports.
 */

function slugify(str, fallback) {
  const s = String(str || '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return s || fallback;
}

/** Postman stores variables as [{key,value,disabled}] or as a plain object. */
function varsToObject(list, into = {}) {
  if (!list) return into;
  if (Array.isArray(list)) {
    for (const v of list) {
      // Collections mark entries `disabled: true`; environment exports use
      // `enabled: false` instead, so both spellings have to be honoured.
      if (!v || v.disabled || v.enabled === false) continue;
      const key = v.key || v.name;
      if (key) into[key] = v.value == null ? '' : String(v.value);
    }
  } else if (typeof list === 'object') {
    for (const [k, v] of Object.entries(list)) into[k] = v == null ? '' : String(v);
  }
  return into;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Postman writes path placeholders as `:id` and carries their values in
 * `url.variable`. A filled-in value is substituted directly; an empty one
 * becomes a `{{id}}` placeholder so it surfaces in the variables panel and
 * can be supplied once for the whole run.
 */
function applyPathVariables(rawUrl, variables) {
  if (!rawUrl || !Array.isArray(variables) || !variables.length) return rawUrl;
  let out = rawUrl;
  for (const variable of variables) {
    const key = variable && (variable.key || variable.id);
    if (!key) continue;
    const value = variable.value == null || variable.value === '' ? '{{' + key + '}}' : String(variable.value);
    out = out.replace(new RegExp(':' + escapeRe(key) + '(?=[/?#]|$)', 'g'), value);
  }
  return out;
}

function urlToString(url) {
  if (!url) return '';
  if (typeof url === 'string') return url;
  if (url.raw) {
    // Drop query params Postman has disabled - the raw string still carries them.
    const disabled = (url.query || []).filter((q) => q && q.disabled && q.key);
    let raw = url.raw;
    for (const q of disabled) {
      raw = raw
        .replace(new RegExp('([?&])' + escapeRe(q.key) + '=[^&#]*&?', 'g'), '$1')
        .replace(/[?&]$/, '');
    }
    return applyPathVariables(raw, url.variable);
  }
  const protocol = url.protocol ? url.protocol + '://' : '';
  const host = Array.isArray(url.host) ? url.host.join('.') : url.host || '';
  const port = url.port ? ':' + url.port : '';
  const pathPart = Array.isArray(url.path) ? '/' + url.path.join('/') : url.path || '';
  const query = (url.query || [])
    .filter((q) => q && !q.disabled && q.key)
    .map((q) => q.key + '=' + (q.value == null ? '' : q.value))
    .join('&');
  return applyPathVariables(protocol + host + port + pathPart, url.variable) + (query ? '?' + query : '');
}

function headersToObject(list) {
  const out = {};
  if (!Array.isArray(list)) return out;
  for (const h of list) {
    if (!h || h.disabled || !h.key) continue;
    out[h.key] = h.value == null ? '' : String(h.value);
  }
  return out;
}

function parseBody(body) {
  if (!body || body.disabled) return null;
  switch (body.mode) {
    case 'raw': {
      const lang = (body.options && body.options.raw && body.options.raw.language) || 'text';
      return { mode: 'raw', raw: body.raw || '', language: lang };
    }
    case 'urlencoded': {
      const fields = (body.urlencoded || [])
        .filter((f) => f && !f.disabled && f.key)
        .map((f) => ({ key: f.key, value: f.value == null ? '' : String(f.value) }));
      return { mode: 'urlencoded', fields };
    }
    case 'formdata': {
      const fields = (body.formdata || [])
        .filter((f) => f && !f.disabled && f.key)
        .map((f) => ({
          key: f.key,
          value: f.type === 'file' ? '' : f.value == null ? '' : String(f.value),
          type: f.type === 'file' ? 'file' : 'text',
          src: f.type === 'file' ? f.src || '' : undefined,
        }));
      return { mode: 'formdata', fields };
    }
    case 'graphql': {
      const g = body.graphql || {};
      let variables = g.variables;
      if (typeof variables === 'string') {
        try {
          variables = JSON.parse(variables || '{}');
        } catch (e) {
          variables = {};
        }
      }
      return { mode: 'graphql', query: g.query || '', variables: variables || {} };
    }
    case 'file':
      return { mode: 'file', src: (body.file && body.file.src) || '' };
    default:
      return null;
  }
}

function parseAuth(auth) {
  if (!auth || !auth.type || auth.type === 'noauth') return null;
  const type = auth.type;
  const params = varsToObject(auth[type] || []);
  switch (type) {
    case 'bearer':
      return { type: 'bearer', token: params.token || '' };
    case 'basic':
      return { type: 'basic', username: params.username || '', password: params.password || '' };
    case 'apikey':
      return {
        type: 'apikey',
        key: params.key || '',
        value: params.value || '',
        in: (params.in || 'header').toLowerCase(),
      };
    case 'oauth2':
      return { type: 'bearer', token: params.accessToken || '' };
    default:
      return { type: 'unsupported', raw: type };
  }
}

/**
 * Mirrors the common `pm.environment.set('x', pm.response.json().y)` idiom from
 * Postman test scripts as a declarative capture the k6 script can replay.
 */
function parseCaptures(events) {
  const captures = [];
  if (!Array.isArray(events)) return captures;
  for (const ev of events) {
    if (!ev || ev.listen !== 'test' || !ev.script) continue;
    const src = Array.isArray(ev.script.exec) ? ev.script.exec.join('\n') : String(ev.script.exec || '');
    // The value expression itself contains parentheses, so the capture runs to
    // the end of the line and the JSON path is picked out of it afterwards.
    const setRe = /pm\.(?:environment|globals|collectionVariables|variables)\.set\(\s*["'`]([^"'`]+)["'`]\s*,([^\n]*)/g;
    let m;
    while ((m = setRe.exec(src))) {
      const name = m[1];
      const expr = m[2];
      const jsonPath = /(?:pm\.)?response\.json\(\)((?:[.[][^\s;]*)?)/.exec(expr);
      if (jsonPath) {
        const path = (jsonPath[1] || '')
          .replace(/\[["']?([^\]"']+)["']?\]/g, '.$1')
          .replace(/^\.+/, '')
          .replace(/[);,\s]+$/, ''); // drop the tail of the enclosing set(...) call
        captures.push({ as: name, from: 'json', path });
      }
    }
  }
  return captures;
}

function flatten(items, parents, out, inheritedAuth) {
  for (const item of items || []) {
    if (!item) continue;
    if (Array.isArray(item.item)) {
      const folderAuth = parseAuth(item.auth) || inheritedAuth;
      flatten(item.item, parents.concat(item.name || 'folder'), out, folderAuth);
      continue;
    }
    if (!item.request) continue;
    const req = typeof item.request === 'string' ? { method: 'GET', url: item.request } : item.request;
    const idx = out.length;
    const name = item.name || (req.method || 'GET') + ' request ' + (idx + 1);
    out.push({
      id: 'r' + idx + '_' + slugify(name, 'req'),
      name,
      folder: parents.join(' / '),
      method: (req.method || 'GET').toUpperCase(),
      url: urlToString(req.url),
      headers: headersToObject(req.header),
      body: parseBody(req.body),
      auth: parseAuth(req.auth) || inheritedAuth || null,
      captures: parseCaptures(item.event),
      expectStatus: '2xx',
      weight: 1,
      enabled: true,
    });
  }
  return out;
}

/**
 * @param {object} collection parsed postman_collection.json
 * @param {object} [environment] parsed postman_environment.json (optional)
 */
function parseCollection(collection, environment) {
  if (!collection || typeof collection !== 'object') throw new Error('Collection is not a JSON object');
  if (!Array.isArray(collection.item)) throw new Error('Not a Postman collection: missing "item" array');

  const vars = {};
  varsToObject(collection.variable, vars);
  if (environment) varsToObject(environment.values || environment.variable, vars);

  const rootAuth = parseAuth(collection.auth);
  const requests = flatten(collection.item, [], [], rootAuth);

  // Surface every {{placeholder}} used anywhere so the UI can prompt for values.
  const used = new Set();
  const scan = (s) => {
    if (typeof s !== 'string') return;
    const re = /\{\{([^}\s]+)\}\}/g;
    let m;
    // `{{$randomInt}}` and friends are generated at runtime, so they are not
    // values anyone needs to supply.
    while ((m = re.exec(s))) if (!m[1].startsWith('$')) used.add(m[1]);
  };
  for (const r of requests) {
    scan(r.url);
    Object.entries(r.headers).forEach(([k, v]) => {
      scan(k);
      scan(v);
    });
    if (r.body) scan(JSON.stringify(r.body));
    if (r.auth) scan(JSON.stringify(r.auth));
  }
  for (const name of used) if (!(name in vars)) vars[name] = '';

  return {
    name: (collection.info && collection.info.name) || 'Postman collection',
    description: (collection.info && collection.info.description) || '',
    variables: vars,
    requests,
  };
}

module.exports = { parseCollection, slugify };
