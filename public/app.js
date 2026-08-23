/* k6 Load Lab - browser client */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MAX_LIVE_POINTS = 900; // ~15 minutes of 1s ticks on screen

  const READ_ONLY_METHODS = ['GET', 'HEAD', 'OPTIONS'];

  // Replaced at boot by /api/presets so the CLI and the UI cannot drift apart.
  let PRESETS = [
    { key: 'smoke', name: 'Smoke', hint: '1 VU, 30s', profile: { executor: 'ramping-vus', stages: [{ duration: '30s', target: 1 }] } },
    { key: 'average', name: 'Average load', hint: '20 VUs, 5 min', profile: { executor: 'ramping-vus', stages: [{ duration: '1m', target: 20 }, { duration: '3m', target: 20 }, { duration: '1m', target: 0 }] } },
    { key: 'stress', name: 'Stress', hint: 'up to 200 VUs', profile: { executor: 'ramping-vus', stages: [{ duration: '2m', target: 50 }, { duration: '3m', target: 100 }, { duration: '3m', target: 200 }, { duration: '2m', target: 0 }] } },
    { key: 'spike', name: 'Spike', hint: '0 to 300 in 20s', profile: { executor: 'ramping-vus', stages: [{ duration: '20s', target: 300 }, { duration: '1m', target: 300 }, { duration: '20s', target: 0 }] } },
    { key: 'soak', name: 'Soak', hint: '30 VUs, 1 hour', profile: { executor: 'ramping-vus', stages: [{ duration: '3m', target: 30 }, { duration: '54m', target: 30 }, { duration: '3m', target: 0 }] } },
    { key: 'breakpoint', name: 'Breakpoint', hint: 'ramp until it breaks', profile: { executor: 'ramping-arrival-rate', startRate: 10, preAllocatedVUs: 100, maxVUs: 1000, stages: [{ duration: '2m', target: 100 }, { duration: '2m', target: 300 }, { duration: '2m', target: 600 }, { duration: '2m', target: 1000 }] } },
  ];

  const state = {
    requests: [],
    variables: {},
    collectionName: '',
    environmentName: '',
    profile: defaultProfile(),
    live: null,
    ticks: [],
    charts: {},
    expanded: {},
  };

  function defaultProfile() {
    return {
      name: 'Load test',
      executor: 'ramping-vus',
      stages: [
        { duration: '30s', target: 10 },
        { duration: '1m', target: 10 },
        { duration: '30s', target: 0 },
      ],
      vus: 10,
      rate: 50,
      duration: '1m',
      iterations: 100,
      preAllocatedVUs: 50,
      maxVUs: 200,
      flow: 'sequence',
      thinkTimeMin: 0.5,
      thinkTimeMax: 1.5,
      requestTimeout: '60s',
      rpsLimit: 0,
      stopOnError: false,
      noConnectionReuse: false,
      insecureSkipTLSVerify: true,
      thresholds: { p95: 800, p99: '', errorRate: 1, checkRate: 99 },
    };
  }

  // ---------------------------------------------------------------- helpers

  function toast(message, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 5200);
  }

  function fmt(value, digits) {
    return Number(value || 0).toLocaleString('en-US', {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits || 0,
    });
  }

  function ms(value) {
    const n = Number(value || 0);
    return n >= 1000 ? (n / 1000).toFixed(2) + ' s' : n.toFixed(0) + ' ms';
  }

  function bytes(value) {
    let v = Number(value || 0);
    const units = ['B', 'kB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(i ? 2 : 0) + ' ' + units[i];
  }

  function hhmmss(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    const m = Math.floor(s / 60);
    const rest = s % 60;
    const h = Math.floor(m / 60);
    return (h ? h + 'h ' : '') + (h || m ? (m % 60) + 'm ' : '') + rest + 's';
  }

  function parseDuration(text) {
    const s = String(text || '').trim();
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
    let total = 0;
    let match;
    while ((match = re.exec(s))) {
      const n = parseFloat(match[1]);
      total += match[2] === 'ms' ? n / 1000 : match[2] === 's' ? n : match[2] === 'm' ? n * 60 : n * 3600;
    }
    return total;
  }

  async function api(path, options) {
    const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options));
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function save() {
    try {
      localStorage.setItem('k6lab', JSON.stringify({
        requests: state.requests,
        variables: state.variables,
        profile: state.profile,
        collectionName: state.collectionName,
      }));
    } catch (e) { /* storage full or blocked - not fatal */ }
  }

  function restore() {
    try {
      const raw = localStorage.getItem('k6lab');
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (Array.isArray(saved.requests)) state.requests = saved.requests;
      if (saved.variables) state.variables = saved.variables;
      if (saved.profile) state.profile = Object.assign(defaultProfile(), saved.profile);
      state.collectionName = saved.collectionName || '';
    } catch (e) { /* ignore corrupt state */ }
  }

  // ---------------------------------------------------------------- tabs

  function showView(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
    if (name === 'reports') loadRuns();
    if (name === 'profile') renderRamp();
  }

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => showView(tab.dataset.view));
  });

  // ---------------------------------------------------------------- requests

  function renderRequests() {
    const body = $('requestBody');
    body.innerHTML = '';
    const rows = state.requests;
    $('requestEmpty').style.display = rows.length ? 'none' : 'block';
    $('reqCount').textContent = rows.length;
    const selected = rows.filter((r) => r.enabled !== false).length;
    // Weight is only consulted by the random flow; sequence runs each request once.
    const weightApplies = state.profile.flow === 'random';
    $('reqSummary').textContent = rows.length
      ? selected + ' of ' + rows.length + ' selected' + (state.collectionName ? ' from ' + state.collectionName : '') +
        (weightApplies ? '' : ' · weight ignored in Sequence flow')
      : 'nothing loaded yet';
    $('selectedCount').textContent = selected;

    rows.forEach((req, index) => {
      const tr = document.createElement('tr');
      if (req.enabled === false) tr.className = 'disabled';
      tr.innerHTML =
        '<td><input type="checkbox" data-act="toggle" data-i="' + index + '"' + (req.enabled !== false ? ' checked' : '') + ' /></td>' +
        '<td><span class="method ' + req.method + '">' + req.method + '</span></td>' +
        '<td class="truncate" style="max-width:220px" title="' + escapeAttr(req.name) + '">' +
          (req.folder ? '<div class="muted" style="font-size:11px">' + escapeHtml(req.folder) + '</div>' : '') +
          escapeHtml(req.name) + '</td>' +
        '<td class="truncate mono muted" style="max-width:340px" title="' + escapeAttr(req.url) + '">' + escapeHtml(req.url) + '</td>' +
        '<td><input type="text" data-act="expect" data-i="' + index + '" value="' + escapeAttr(req.expectStatus || '2xx') + '" /></td>' +
        '<td class="num"><input type="number" min="1" data-act="weight" data-i="' + index + '" value="' + (req.weight || 1) + '"' +
          (weightApplies ? '' : ' disabled title="Weight only applies to the Random flow. In Sequence flow every request runs once per iteration."') + ' /></td>' +
        '<td class="num"><input type="number" min="0" placeholder="-" data-act="p95" data-i="' + index + '" value="' + (req.p95 == null ? '' : req.p95) + '" /></td>' +
        '<td><button class="btn sm ghost" data-act="detail" data-i="' + index + '">' + (state.expanded[index] ? 'Hide' : 'Info') + '</button></td>';
      body.appendChild(tr);

      if (state.expanded[index]) {
        const detail = document.createElement('tr');
        detail.className = 'detail-row';
        detail.innerHTML = '<td colspan="8">' + requestDetail(req, index) + '</td>';
        body.appendChild(detail);
      }
    });

    renderWarnings();
  }

  /**
   * Mirrors the CLI's pre-flight checks: placeholders with no value, template
   * values left untouched, and write/delete endpoints about to be hammered.
   */
  function renderWarnings() {
    const box = $('reqWarnings');
    if (!box) return;
    const selected = state.requests.filter((r) => r.enabled !== false);
    if (!selected.length) {
      box.innerHTML = '';
      return;
    }

    const used = new Set();
    const scan = (text) => {
      if (typeof text !== 'string') return;
      const re = /\{\{([^}\s]+)\}\}/g;
      let m;
      while ((m = re.exec(text))) if (!m[1].startsWith('$')) used.add(m[1]);
    };
    const captured = new Set();
    selected.forEach((r) => {
      scan(r.url);
      Object.entries(r.headers || {}).forEach(([k, v]) => { scan(k); scan(v); });
      if (r.body) scan(JSON.stringify(r.body));
      if (r.auth) scan(JSON.stringify(r.auth));
      (r.captures || []).forEach((cap) => captured.add(cap.as));
    });

    const messages = [];
    const empty = [...used].filter((name) => !captured.has(name) && !String(state.variables[name] || '').trim());
    if (empty.length) {
      messages.push(['bad', 'These variables have no value and will be sent empty: <b>' + empty.map(escapeHtml).join(', ') + '</b>']);
    }
    const template = Object.entries(state.variables)
      .filter(([, v]) => /^(PASTE_|CHANGE_?ME|your-api\.example\.com|<.*>)/i.test(String(v || '')))
      .map(([k]) => k);
    if (template.length) {
      messages.push(['bad', 'Still holding the template placeholder value: <b>' + template.map(escapeHtml).join(', ') + '</b>']);
    }
    const destructive = selected.filter((r) => ['DELETE', 'PUT', 'PATCH'].indexOf(r.method) >= 0);
    if (destructive.length) {
      messages.push(['warn', '<b>' + destructive.length + '</b> selected request(s) use DELETE/PUT/PATCH and will be called repeatedly against the target. Use <b>Safe mode</b> to drop them.']);
    }
    const writes = selected.filter((r) => r.method === 'POST');
    if (writes.length && !destructive.length) {
      messages.push(['warn', '<b>' + writes.length + '</b> selected request(s) POST data and will create records on every iteration.']);
    }

    box.innerHTML = messages.length
      ? '<div style="padding:14px 18px;border-top:1px solid var(--line-soft)">' +
          messages.map(([kind, text]) =>
            '<div style="margin-bottom:6px;font-size:12.5px" class="' + (kind === 'bad' ? 'bad-text' : 'warn-text') + '">' +
            (kind === 'bad' ? '&#10007;' : '&#33;') + ' ' + text + '</div>'
          ).join('') +
        '</div>'
      : '';
  }

  function requestDetail(req, index) {
    const headers = Object.entries(req.headers || {});
    const rows = [
      ['URL', '<span class="mono">' + escapeHtml(req.url) + '</span>'],
      ['Headers', headers.length
        ? headers.map(([k, v]) => '<span class="mono">' + escapeHtml(k) + ': ' + escapeHtml(v) + '</span>').join('<br />')
        : '<span class="muted">none</span>'],
      ['Auth', req.auth ? '<span class="mono">' + escapeHtml(req.auth.type) + '</span>' : '<span class="muted">none</span>'],
      ['Body', req.body
        ? '<span class="mono">' + escapeHtml(bodyPreview(req.body)) + '</span>'
        : '<span class="muted">none</span>'],
      ['Captures', (req.captures || []).length
        ? req.captures.map((c) => '<span class="mono">' + escapeHtml(c.as) + ' &larr; ' + escapeHtml(c.from) + ':' + escapeHtml(c.path) + '</span>').join('<br />')
        : '<span class="muted">none</span>'],
    ];
    return '<div class="detail-grid">' +
      rows.map((r) => '<div>' + r[0] + '</div><div>' + r[1] + '</div>').join('') +
      '</div><button class="btn sm danger" data-act="remove" data-i="' + index + '">Remove request</button>';
  }

  function bodyPreview(body) {
    if (body.mode === 'raw') return String(body.raw || '').slice(0, 400);
    if (body.mode === 'graphql') return String(body.query || '').slice(0, 400);
    if (body.fields) return body.fields.map((f) => f.key + '=' + f.value).join('&').slice(0, 400);
    return body.mode;
  }

  $('requestBody').addEventListener('input', (event) => {
    const target = event.target;
    const index = Number(target.dataset.i);
    const req = state.requests[index];
    if (!req) return;
    if (target.dataset.act === 'expect') req.expectStatus = target.value;
    if (target.dataset.act === 'weight') req.weight = Number(target.value) || 1;
    if (target.dataset.act === 'p95') req.p95 = target.value === '' ? null : Number(target.value);
    if (target.dataset.act === 'toggle') { req.enabled = target.checked; renderRequests(); }
    save();
  });

  $('requestBody').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const index = Number(button.dataset.i);
    if (button.dataset.act === 'detail') {
      state.expanded[index] = !state.expanded[index];
      renderRequests();
    }
    if (button.dataset.act === 'remove') {
      state.requests.splice(index, 1);
      state.expanded = {};
      renderRequests();
      save();
    }
  });

  $('btnSafeMode').onclick = () => {
    state.requests.forEach((r) => (r.enabled = READ_ONLY_METHODS.indexOf(r.method) >= 0));
    renderRequests();
    save();
    toast('Safe mode: only read-only requests are selected');
  };

  $('btnSelectAll').onclick = () => { state.requests.forEach((r) => (r.enabled = true)); renderRequests(); save(); };
  $('btnSelectNone').onclick = () => { state.requests.forEach((r) => (r.enabled = false)); renderRequests(); save(); };
  $('btnClearRequests').onclick = () => {
    if (!confirm('Remove all loaded requests?')) return;
    state.requests = [];
    state.variables = {};
    state.collectionName = '';
    state.expanded = {};
    renderRequests();
    renderVariables();
    save();
  };

  // ---------------------------------------------------------------- variables

  function renderVariables() {
    const list = $('varList');
    list.innerHTML = '';
    const entries = Object.entries(state.variables);
    if (!entries.length) {
      list.innerHTML = '<div class="muted" style="font-size:13px">No variables yet. Importing a collection fills this in automatically.</div>';
      return;
    }
    entries.forEach(([key, value]) => {
      const row = document.createElement('div');
      row.className = 'kv-row';
      row.innerHTML =
        '<input type="text" value="' + escapeAttr(key) + '" data-vk="' + escapeAttr(key) + '" data-role="key" />' +
        '<input type="text" value="' + escapeAttr(value) + '" data-vk="' + escapeAttr(key) + '" data-role="value" placeholder="value" />' +
        '<button class="btn sm danger" data-vk="' + escapeAttr(key) + '" data-role="del">Remove</button>';
      list.appendChild(row);
    });
  }

  $('varList').addEventListener('input', (event) => {
    const key = event.target.dataset.vk;
    const role = event.target.dataset.role;
    if (key == null) return;
    if (role === 'value') { state.variables[key] = event.target.value; renderWarnings(); }
    if (role === 'key') {
      const value = state.variables[key];
      delete state.variables[key];
      state.variables[event.target.value] = value;
      event.target.dataset.vk = event.target.value;
    }
    save();
  });

  $('varList').addEventListener('click', (event) => {
    if (event.target.dataset.role !== 'del') return;
    delete state.variables[event.target.dataset.vk];
    renderVariables();
    save();
  });

  $('btnAddVar').onclick = () => {
    let name = 'variable';
    let n = 1;
    while (state.variables[name] !== undefined) name = 'variable' + n++;
    state.variables[name] = '';
    renderVariables();
    save();
  };

  // ---------------------------------------------------------------- import

  const dropzone = $('dropzone');
  dropzone.addEventListener('click', () => $('fileCollection').click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('over');
    if (e.dataTransfer.files[0]) readCollection(e.dataTransfer.files[0]);
  });

  $('fileCollection').addEventListener('change', (e) => {
    if (e.target.files[0]) readCollection(e.target.files[0]);
  });

  $('btnPickEnv').onclick = () => $('fileEnvironment').click();
  $('fileEnvironment').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        state.environment = JSON.parse(reader.result);
        state.environmentName = file.name;
        $('envName').textContent = file.name + ' loaded - re-import the collection to apply';
        toast('Environment loaded: ' + file.name, 'ok');
      } catch (err) {
        toast('Could not parse environment file: ' + err.message, 'bad');
      }
    };
    reader.readAsText(file);
  });

  function readCollection(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const collection = JSON.parse(reader.result);
        const parsed = await api('/api/import/postman', {
          method: 'POST',
          body: JSON.stringify({ collection, environment: state.environment || null }),
        });
        applyImport(parsed, file.name);
      } catch (err) {
        toast('Import failed: ' + err.message, 'bad');
      }
    };
    reader.readAsText(file);
  }

  $('btnLoadPath').onclick = async () => {
    const path = $('collectionPath').value.trim();
    if (!path) return toast('Enter a file path first', 'bad');
    try {
      const parsed = await api('/api/import/path', { method: 'POST', body: JSON.stringify({ path }) });
      applyImport(parsed, path.split(/[\\/]/).pop());
    } catch (err) {
      toast('Import failed: ' + err.message, 'bad');
    }
  };

  function applyImport(parsed, label) {
    state.requests = parsed.requests;
    state.variables = Object.assign({}, parsed.variables, state.variables);
    state.collectionName = parsed.name || label;
    state.expanded = {};
    if (state.profile.name === 'Load test') {
      state.profile.name = parsed.name || 'Load test';
      $('pName').value = state.profile.name;
    }
    renderRequests();
    renderVariables();
    save();
    const missing = Object.entries(parsed.variables).filter(([, v]) => !v).map(([k]) => k);
    toast('Imported ' + parsed.requests.length + ' requests from ' + state.collectionName, 'ok');
    if (missing.length) {
      toast('These variables have no value yet: ' + missing.slice(0, 6).join(', ') + (missing.length > 6 ? '...' : ''), 'bad');
    }
  }

  // ---------------------------------------------------------------- single API

  $('sAuthType').addEventListener('change', () => {
    const type = $('sAuthType').value;
    $('sAuthFields').style.display = type ? 'block' : 'none';
    $('sAuthBWrap').style.display = type === 'basic' || type === 'apikey' ? 'block' : 'none';
    $('sAuthA').placeholder = type === 'basic' ? 'username' : type === 'apikey' ? 'header name' : 'token';
    $('sAuthB').placeholder = type === 'basic' ? 'password' : 'key value';
  });

  $('btnAddSingle').onclick = () => {
    const url = $('sUrl').value.trim();
    if (!url) return toast('A URL is required', 'bad');
    const method = $('sMethod').value;
    const name = $('sName').value.trim() || method + ' ' + shortUrl(url);

    const headers = {};
    $('sHeaders').value.split(/\r?\n/).forEach((line) => {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });

    const rawBody = $('sBody').value.trim();
    const looksJson = /^[[{]/.test(rawBody);
    const authType = $('sAuthType').value;
    let auth = null;
    if (authType === 'bearer') auth = { type: 'bearer', token: $('sAuthA').value };
    if (authType === 'basic') auth = { type: 'basic', username: $('sAuthA').value, password: $('sAuthB').value };
    if (authType === 'apikey') auth = { type: 'apikey', key: $('sAuthA').value, value: $('sAuthB').value, in: 'header' };

    state.requests.push({
      id: 'r' + state.requests.length + '_' + name.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40),
      name,
      folder: '',
      method,
      url,
      headers,
      body: rawBody ? { mode: 'raw', raw: rawBody, language: looksJson ? 'json' : 'text' } : null,
      auth,
      captures: [],
      expectStatus: $('sExpect').value.trim() || '2xx',
      weight: 1,
      enabled: true,
    });

    scanForVariables();
    renderRequests();
    renderVariables();
    save();
    $('sUrl').value = '';
    $('sName').value = '';
    $('sBody').value = '';
    toast('Added ' + name, 'ok');
  };

  function shortUrl(url) {
    try {
      const parsed = new URL(url.replace(/\{\{[^}]+\}\}/g, 'x'));
      return parsed.pathname === '/' ? parsed.hostname : parsed.pathname;
    } catch (e) {
      return url.slice(0, 40);
    }
  }

  /** Makes sure every {{placeholder}} in the request list has a variable row. */
  function scanForVariables() {
    const found = new Set();
    const scan = (text) => {
      if (typeof text !== 'string') return;
      const re = /\{\{([^}\s]+)\}\}/g;
      let m;
      while ((m = re.exec(text))) if (!m[1].startsWith('$')) found.add(m[1]);
    };
    state.requests.forEach((r) => {
      scan(r.url);
      Object.entries(r.headers || {}).forEach(([k, v]) => { scan(k); scan(v); });
      if (r.body) scan(JSON.stringify(r.body));
      if (r.auth) scan(JSON.stringify(r.auth));
    });
    found.forEach((name) => { if (state.variables[name] === undefined) state.variables[name] = ''; });
  }

  // ---------------------------------------------------------------- profile

  function renderPresets() {
    const row = $('presetRow');
    row.innerHTML = '';
    PRESETS.forEach((preset) => {
      const button = document.createElement('button');
      button.className = 'preset';
      button.innerHTML = '<b>' + preset.name + '</b><span>' + preset.hint + '</span>';
      button.onclick = () => {
        Object.assign(state.profile, JSON.parse(JSON.stringify(preset.profile)));
        profileToForm();
        renderStages();
        renderRamp();
        save();
        toast('Applied the ' + preset.name + ' profile');
      };
      row.appendChild(button);
    });
  }

  function renderStages() {
    const list = $('stageList');
    list.innerHTML = '';
    const isRate = state.profile.executor === 'ramping-arrival-rate';
    (state.profile.stages || []).forEach((stage, index) => {
      const row = document.createElement('div');
      row.className = 'stage-row';
      row.innerHTML =
        '<div class="idx">' + (index + 1) + '</div>' +
        '<input type="text" data-si="' + index + '" data-sf="duration" value="' + escapeAttr(stage.duration) + '" placeholder="30s" />' +
        '<input type="number" min="0" data-si="' + index + '" data-sf="target" value="' + stage.target + '" placeholder="' + (isRate ? 'requests/s' : 'VUs') + '" />' +
        '<button class="btn sm danger" data-si="' + index + '" data-sf="del">&times;</button>';
      list.appendChild(row);
    });
  }

  $('stageList').addEventListener('input', (event) => {
    const index = Number(event.target.dataset.si);
    const field = event.target.dataset.sf;
    if (!state.profile.stages[index] || !field) return;
    state.profile.stages[index][field] = field === 'target' ? Number(event.target.value) : event.target.value;
    renderRamp();
    save();
  });

  $('stageList').addEventListener('click', (event) => {
    if (event.target.dataset.sf !== 'del') return;
    state.profile.stages.splice(Number(event.target.dataset.si), 1);
    renderStages();
    renderRamp();
    save();
  });

  $('btnAddStage').onclick = () => {
    const stages = state.profile.stages;
    const last = stages[stages.length - 1];
    stages.push({ duration: '30s', target: last ? Math.max(1, last.target) : 10 });
    renderStages();
    renderRamp();
    save();
  };

  const FORM_FIELDS = [
    ['pName', 'name'], ['pExecutor', 'executor'], ['pVus', 'vus', Number], ['pRate', 'rate', Number],
    ['pDuration', 'duration'], ['pIterations', 'iterations', Number],
    ['pPreAllocatedVUs', 'preAllocatedVUs', Number], ['pMaxVUs', 'maxVUs', Number],
    ['pFlow', 'flow'], ['pThinkMin', 'thinkTimeMin', Number], ['pThinkMax', 'thinkTimeMax', Number],
    ['pTimeout', 'requestTimeout'], ['pRpsLimit', 'rpsLimit', Number],
  ];
  const CHECK_FIELDS = [['pStopOnError', 'stopOnError'], ['pNoReuse', 'noConnectionReuse'], ['pInsecure', 'insecureSkipTLSVerify']];
  const THRESHOLD_FIELDS = [['thP95', 'p95'], ['thP99', 'p99'], ['thErrorRate', 'errorRate'], ['thCheckRate', 'checkRate']];

  function profileToForm() {
    FORM_FIELDS.forEach(([id, key]) => { $(id).value = state.profile[key]; });
    CHECK_FIELDS.forEach(([id, key]) => { $(id).checked = !!state.profile[key]; });
    THRESHOLD_FIELDS.forEach(([id, key]) => { $(id).value = state.profile.thresholds[key]; });
    syncExecutorFields();
  }

  function formToProfile() {
    FORM_FIELDS.forEach(([id, key, cast]) => {
      const value = $(id).value;
      state.profile[key] = cast ? cast(value) : value;
    });
    CHECK_FIELDS.forEach(([id, key]) => { state.profile[key] = $(id).checked; });
    THRESHOLD_FIELDS.forEach(([id, key]) => { state.profile.thresholds[key] = $(id).value; });
  }

  function syncExecutorFields() {
    const executor = state.profile.executor;
    const staged = executor === 'ramping-vus' || executor === 'ramping-arrival-rate';
    const arrival = executor.indexOf('arrival-rate') >= 0;
    const iterations = executor.indexOf('iterations') >= 0;

    $('stageSection').style.display = staged ? 'block' : 'none';
    $('simpleSection').style.display = staged ? 'none' : 'flex';
    $('arrivalSection').style.display = arrival ? 'flex' : 'none';
    $('rateWrap').style.display = executor === 'constant-arrival-rate' ? 'block' : 'none';
    $('iterWrap').style.display = iterations ? 'block' : 'none';
    renderStages();
  }

  ['input', 'change'].forEach((eventName) => {
    document.querySelector('[data-view="profile"]').addEventListener(eventName, (event) => {
      if (event.target.closest('#stageList') || event.target.closest('#presetRow')) return;
      formToProfile();
      if (event.target.id === 'pExecutor') syncExecutorFields();
      if (event.target.id === 'pFlow') renderRequests();
      renderRamp();
      save();
    });
  });

  /** Draws the planned ramp so the shape of the test is obvious before it runs. */
  function renderRamp() {
    const svg = $('rampSvg');
    const W = 600;
    const H = 170;
    const pad = { l: 40, r: 12, t: 14, b: 26 };
    const profile = state.profile;
    const points = [];
    const isRate = profile.executor === 'ramping-arrival-rate';
    let unit = isRate ? 'req/s' : 'VUs';

    if (profile.executor === 'ramping-vus' || isRate) {
      let t = 0;
      let level = isRate ? Number(profile.startRate || 0) : Number(profile.startVUs || 0);
      points.push([0, level]);
      (profile.stages || []).forEach((stage) => {
        t += parseDuration(stage.duration);
        level = Number(stage.target || 0);
        points.push([t, level]);
      });
    } else if (profile.executor === 'constant-arrival-rate') {
      const d = parseDuration(profile.duration);
      points.push([0, Number(profile.rate)], [d, Number(profile.rate)]);
    } else {
      const d = parseDuration(profile.duration) || 60;
      points.push([0, Number(profile.vus)], [d, Number(profile.vus)]);
    }

    const totalTime = Math.max(1, points[points.length - 1][0]);
    const peak = Math.max(1, ...points.map((p) => p[1]));
    const x = (t) => pad.l + (t / totalTime) * (W - pad.l - pad.r);
    const y = (v) => H - pad.b - (v / peak) * (H - pad.t - pad.b);

    const line = points.map((p, i) => (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join(' ');
    const area = line + ' L' + x(totalTime).toFixed(1) + ' ' + y(0) + ' L' + x(0).toFixed(1) + ' ' + y(0) + ' Z';

    const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const gy = y(peak * f);
      return '<line x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + gy + '" y2="' + gy + '" stroke="#263041" stroke-width="1" />' +
        '<text x="' + (pad.l - 6) + '" y="' + (gy + 4) + '" fill="#5e6b80" font-size="10" text-anchor="end">' + Math.round(peak * f) + '</text>';
    }).join('');

    const markers = points.map((p) =>
      '<circle cx="' + x(p[0]).toFixed(1) + '" cy="' + y(p[1]).toFixed(1) + '" r="3" fill="#4f8cff" />'
    ).join('');

    svg.innerHTML =
      '<defs><linearGradient id="rampFill" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#4f8cff" stop-opacity="0.45" />' +
      '<stop offset="100%" stop-color="#4f8cff" stop-opacity="0.02" /></linearGradient></defs>' +
      gridLines +
      '<path d="' + area + '" fill="url(#rampFill)" />' +
      '<path d="' + line + '" fill="none" stroke="#4f8cff" stroke-width="2.5" stroke-linejoin="round" />' +
      markers +
      '<text x="' + pad.l + '" y="' + (H - 8) + '" fill="#5e6b80" font-size="10">0s</text>' +
      '<text x="' + (W - pad.r) + '" y="' + (H - 8) + '" fill="#5e6b80" font-size="10" text-anchor="end">' + hhmmss(totalTime) + '</text>';

    $('plannedDuration').textContent = hhmmss(totalTime);
    $('peakLoad').textContent = peak + ' ' + unit;
    $('rampSummary').textContent = points.length - 1 + ' segment(s)';
  }

  // ---------------------------------------------------------------- launching

  function buildSpec() {
    formToProfile();
    const enabled = state.requests.filter((r) => r.enabled !== false);
    if (!enabled.length) throw new Error('Select at least one request first');
    return { requests: enabled, variables: state.variables, profile: state.profile };
  }

  async function startTest() {
    $('startError').textContent = '';
    let spec;
    try {
      spec = buildSpec();
    } catch (err) {
      $('startError').textContent = err.message;
      return toast(err.message, 'bad');
    }
    try {
      resetLive();
      const runState = await api('/api/runs', { method: 'POST', body: JSON.stringify(spec) });
      state.live = runState;
      showView('live');
      toast('Test started', 'ok');
    } catch (err) {
      $('startError').textContent = err.message;
      toast('Could not start: ' + err.message, 'bad');
    }
  }

  $('btnStart').onclick = startTest;
  $('btnStartTop').onclick = startTest;

  $('btnPreview').onclick = async () => {
    try {
      const result = await api('/api/preview', { method: 'POST', body: JSON.stringify(buildSpec()) });
      $('modalTitle').textContent = 'Generated k6 script';
      $('modalBody').textContent = result.script;
      $('modal').classList.add('open');
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  $('btnCloseModal').onclick = () => $('modal').classList.remove('open');
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').classList.remove('open'); });
  $('btnCopyScript').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('modalBody').textContent);
      toast('Script copied', 'ok');
    } catch (e) {
      toast('Copy failed - select the text manually', 'bad');
    }
  };

  // ---------------------------------------------------------------- live view

  const CHART_BASE = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: '#e7edf8', boxWidth: 12, usePointStyle: true, font: { size: 11 } } } },
  };

  function axis(title) {
    return {
      grid: { color: 'rgba(255,255,255,0.06)' },
      ticks: { color: '#8a97ac', maxTicksLimit: 10, font: { size: 10 } },
      beginAtZero: true,
      title: { display: !!title, text: title, color: '#5e6b80', font: { size: 10 } },
    };
  }

  function initCharts() {
    if (!window.Chart) {
      // vendor/chart.umd.js is copied in by `npm install`; without it the live
      // charts would just be blank, so say so rather than fail quietly.
      if (!state.chartWarningShown) {
        state.chartWarningShown = true;
        toast('Charts unavailable: run "npm install" in the k6 Load Lab folder to restore them.', 'bad');
      }
      return;
    }
    if (state.charts.load) return;

    state.charts.load = new Chart($('chartLoad'), {
      type: 'line',
      data: { labels: [], datasets: [
        { label: 'Virtual users', data: [], borderColor: '#a97bff', backgroundColor: 'rgba(169,123,255,.15)', fill: true, tension: .3, pointRadius: 0, borderWidth: 2, yAxisID: 'y' },
        { label: 'Requests/s', data: [], borderColor: '#4f8cff', backgroundColor: 'rgba(79,140,255,.12)', fill: true, tension: .3, pointRadius: 0, borderWidth: 2, yAxisID: 'y1' },
      ]},
      options: Object.assign({}, CHART_BASE, { scales: {
        x: axis('seconds'),
        y: Object.assign(axis('VUs'), { position: 'left' }),
        y1: Object.assign(axis('req/s'), { position: 'right', grid: { drawOnChartArea: false } }),
      }}),
    });

    state.charts.latency = new Chart($('chartLatency'), {
      type: 'line',
      data: { labels: [], datasets: [
        { label: 'avg', data: [], borderColor: '#2ecc8f', pointRadius: 0, borderWidth: 2, tension: .3 },
        { label: 'p95', data: [], borderColor: '#ffb454', pointRadius: 0, borderWidth: 2, tension: .3 },
        { label: 'p99', data: [], borderColor: '#ff5c72', pointRadius: 0, borderWidth: 2, tension: .3 },
      ]},
      options: Object.assign({}, CHART_BASE, { scales: { x: axis('seconds'), y: axis('ms') } }),
    });

    state.charts.errors = new Chart($('chartErrors'), {
      type: 'line',
      data: { labels: [], datasets: [
        { label: 'error rate %', data: [], borderColor: '#ff5c72', backgroundColor: 'rgba(255,92,114,.18)', fill: true, pointRadius: 0, borderWidth: 2, tension: .3 },
      ]},
      options: Object.assign({}, CHART_BASE, { scales: { x: axis('seconds'), y: axis('%') } }),
    });

    state.charts.status = new Chart($('chartStatus'), {
      type: 'bar',
      data: { labels: [], datasets: [{ label: 'responses', data: [], backgroundColor: [] }] },
      options: Object.assign({}, CHART_BASE, {
        plugins: { legend: { display: false } },
        scales: { x: axis(''), y: axis('responses') },
      }),
    });
  }

  function resetLive() {
    state.ticks = [];
    initCharts();
    ['load', 'latency', 'errors'].forEach((key) => {
      const chart = state.charts[key];
      if (!chart) return;
      chart.data.labels = [];
      chart.data.datasets.forEach((d) => (d.data = []));
      chart.update('none');
    });
    $('liveLog').innerHTML = '';
    $('liveEndpoints').innerHTML = '';
    $('liveErrors').innerHTML = '';
  }

  function pushTick(tick) {
    state.ticks.push(tick);
    if (state.ticks.length > MAX_LIVE_POINTS) state.ticks.shift();

    const labels = state.ticks.map((t) => t.elapsed);
    const load = state.charts.load;
    if (load) {
      load.data.labels = labels;
      load.data.datasets[0].data = state.ticks.map((t) => t.vus);
      load.data.datasets[1].data = state.ticks.map((t) => t.rps);
      load.update('none');
    }
    const latency = state.charts.latency;
    if (latency) {
      latency.data.labels = labels;
      latency.data.datasets[0].data = state.ticks.map((t) => Math.round(t.avg));
      latency.data.datasets[1].data = state.ticks.map((t) => Math.round(t.p95));
      latency.data.datasets[2].data = state.ticks.map((t) => Math.round(t.p99));
      latency.update('none');
    }
    const errors = state.charts.errors;
    if (errors) {
      errors.data.labels = labels;
      errors.data.datasets[0].data = state.ticks.map((t) => Math.round(t.errorRate * 100) / 100);
      errors.update('none');
    }
  }

  const STATUS_COLOURS = { '2': '#2ecc8f', '3': '#4f8cff', '4': '#ffb454', '5': '#ff5c72', '0': '#8a97ac' };

  function renderStatusChart(statusCodes) {
    const chart = state.charts.status;
    if (!chart) return;
    const entries = Object.entries(statusCodes || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
    chart.data.labels = entries.map((e) => (e[0] === '0' ? 'failed' : e[0]));
    chart.data.datasets[0].data = entries.map((e) => e[1]);
    chart.data.datasets[0].backgroundColor = entries.map((e) => STATUS_COLOURS[String(e[0])[0]] || '#8a97ac');
    chart.update('none');
  }

  function renderKpis(totals, tick) {
    if (tick) {
      $('kVus').textContent = fmt(tick.vus);
      $('kRps').textContent = fmt(tick.rps);
    }
    if (!totals) return;
    $('kP95').innerHTML = fmt(totals.p95, 0) + '<span> ms</span>';
    $('kAvg').innerHTML = fmt(totals.avg, 0) + '<span> ms</span>';
    $('kErr').innerHTML = '<span class="' + (totals.errorRate > 0 ? 'bad-text' : 'ok-text') + '">' + fmt(totals.errorRate, 2) + '</span><span> %</span>';
    $('kReqs').textContent = fmt(totals.requests);
    $('kChecks').textContent = fmt(totals.checksPassed) + ' / ' + fmt(totals.checksPassed + totals.checksFailed);
    $('kData').textContent = bytes(totals.dataReceived);
  }

  function renderLiveEndpoints(rows) {
    $('liveEndpoints').innerHTML = (rows || []).map((e) =>
      '<tr><td class="truncate" style="max-width:280px" title="' + escapeAttr(e.name) + '">' + escapeHtml(e.name) + '</td>' +
      '<td class="num">' + fmt(e.requests) + '</td>' +
      '<td class="num">' + fmt(e.failed) + '</td>' +
      '<td class="num ' + (e.errorRate > 0 ? 'bad-text' : '') + '">' + fmt(e.errorRate, 2) + '%</td>' +
      '<td class="num">' + ms(e.avg) + '</td><td class="num">' + ms(e.p90) + '</td>' +
      '<td class="num">' + ms(e.p95) + '</td><td class="num">' + ms(e.p99) + '</td>' +
      '<td class="num">' + ms(e.max) + '</td></tr>'
    ).join('') || '<tr><td colspan="9" class="muted" style="padding:18px">Waiting for the first requests...</td></tr>';
  }

  function renderLiveErrors(rows) {
    $('liveErrors').innerHTML = (rows || []).map((e) =>
      '<tr><td class="truncate" style="max-width:220px">' + escapeHtml(e.endpoint) + '</td>' +
      '<td>' + escapeHtml(e.status) + '</td>' +
      '<td class="muted mono">' + escapeHtml(e.errorCode || '-') + '</td>' +
      '<td class="num">' + fmt(e.count) + '</td></tr>'
    ).join('') || '<tr><td colspan="4" class="muted" style="padding:18px">No failures so far.</td></tr>';
  }

  function appendLog(entry) {
    const box = $('liveLog');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    const line = document.createElement('div');
    line.className = 'lv-' + entry.level;
    line.textContent = entry.message;
    box.appendChild(line);
    while (box.childElementCount > 400) box.removeChild(box.firstChild);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function setRunning(running, status) {
    $('btnStop').disabled = !running;
    $('btnStartTop').disabled = running;
    $('btnStart').disabled = running;

    const chip = $('k6Chip');
    chip.classList.toggle('live', running);
    if (running) $('k6ChipText').textContent = 'test running';

    const badge = $('liveStatus');
    badge.textContent = status || (running ? 'running' : 'idle');
    badge.className = 'badge ' + (status === 'passed' ? 'ok' : status === 'failed' ? 'bad' : running ? 'info' : 'muted');
  }

  function applyState(runState) {
    if (!runState) return;
    state.live = runState;
    $('liveName').textContent = runState.name;
    $('liveSub').textContent =
      (runState.profile ? runState.profile.executor + ' - ' : '') +
      hhmmss(runState.elapsed) + ' elapsed' +
      (runState.plannedDuration ? ' of ' + hhmmss(runState.plannedDuration) : '');
    if (runState.plannedDuration) {
      $('liveProgress').style.width = Math.min(100, (runState.elapsed / runState.plannedDuration) * 100) + '%';
    }
    if (runState.dashboardUrl) $('btnK6Dash').href = runState.dashboardUrl;
    initCharts();
    if (runState.ticks && runState.ticks.length && !state.ticks.length) {
      runState.ticks.slice(-MAX_LIVE_POINTS).forEach(pushTick);
    }
    renderKpis(runState.totals, runState.ticks && runState.ticks[runState.ticks.length - 1]);
    renderLiveEndpoints(runState.endpoints);
    renderLiveErrors(runState.errors);
    renderStatusChart(runState.statusCodes);
    (runState.log || []).forEach(appendLog);
    setRunning(runState.status === 'running', runState.status);
  }

  $('btnStop').onclick = async () => {
    try {
      await api('/api/runs/current/stop', { method: 'POST' });
      toast('Stopping the test gracefully...');
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  // ---------------------------------------------------------------- reports

  async function loadRuns() {
    try {
      const data = await api('/api/runs');
      const body = $('runsBody');
      $('runCount').textContent = data.runs.length;
      $('runsEmpty').style.display = data.runs.length ? 'none' : 'block';
      body.innerHTML = data.runs.map((run) => {
        const totals = run.totals || {};
        const failed = (run.thresholds || []).filter((t) => !t.passed).length;
        const slaCell = (run.thresholds || []).length
          ? failed
            ? '<span class="badge bad">' + failed + ' breached</span>'
            : '<span class="badge ok">met</span>'
          : '<span class="muted">-</span>';
        return '<tr>' +
          '<td>' + escapeHtml(run.name) + '<div class="muted mono" style="font-size:11px">' + escapeHtml(run.id) + '</div></td>' +
          '<td><span class="badge ' + (run.status === 'passed' ? 'ok' : run.status === 'failed' ? 'bad' : 'warn') + '">' + escapeHtml(run.status) + '</span></td>' +
          '<td class="muted">' + (run.startedAt ? new Date(run.startedAt).toLocaleString() : '-') + '</td>' +
          '<td class="num">' + hhmmss(run.duration) + '</td>' +
          '<td class="num">' + fmt(totals.requests) + '</td>' +
          '<td class="num">' + fmt(totals.avgRps, 1) + '</td>' +
          '<td class="num ' + (totals.errorRate > 0 ? 'bad-text' : '') + '">' + fmt(totals.errorRate, 2) + '%</td>' +
          '<td class="num">' + fmt(totals.p95, 0) + ' ms</td>' +
          '<td>' + slaCell + '</td>' +
          '<td>' +
            '<a class="btn sm" href="/reports/' + run.id + '/report.html" target="_blank" rel="noopener">Report</a> ' +
            (run.hasK6Report ? '<a class="btn sm ghost" href="/reports/' + run.id + '/k6-dashboard.html" target="_blank" rel="noopener">k6</a> ' : '') +
            '<a class="btn sm ghost" href="/api/runs/' + run.id + '/script" target="_blank" rel="noopener">Script</a> ' +
            '<button class="btn sm danger" data-del="' + run.id + '">Delete</button>' +
          '</td></tr>';
      }).join('');
    } catch (err) {
      toast('Could not load runs: ' + err.message, 'bad');
    }
  }

  $('runsBody').addEventListener('click', async (event) => {
    const id = event.target.dataset.del;
    if (!id) return;
    if (!confirm('Delete this run and its reports?')) return;
    try {
      await api('/api/runs/' + id, { method: 'DELETE' });
      loadRuns();
      toast('Run deleted');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  $('btnRefreshRuns').onclick = loadRuns;

  // ---------------------------------------------------------------- socket

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(proto + '//' + location.host + '/ws');

    socket.onmessage = (event) => {
      const { type, payload } = JSON.parse(event.data);
      if (type === 'hello') {
        if (payload.state) applyState(payload.state);
        else setRunning(false);
      } else if (type === 'run:start') {
        resetLive();
        applyState(payload);
        toast('Run started: ' + payload.name, 'ok');
      } else if (type === 'run:tick') {
        pushTick(payload.tick);
        renderKpis(payload.totals, payload.tick);
        renderLiveEndpoints(payload.endpoints);
        renderLiveErrors(payload.errors);
        renderStatusChart(payload.statusCodes);
        $('liveSub').textContent = hhmmss(payload.elapsed) + ' elapsed' +
          (payload.plannedDuration ? ' of ' + hhmmss(payload.plannedDuration) : '');
        if (payload.plannedDuration) {
          $('liveProgress').style.width = Math.min(100, (payload.elapsed / payload.plannedDuration) * 100) + '%';
        }
      } else if (type === 'run:log') {
        appendLog(payload);
      } else if (type === 'run:end') {
        setRunning(false, payload.status);
        renderKpis(payload.totals, null);
        renderLiveEndpoints(payload.endpoints);
        renderLiveErrors(payload.errors);
        $('liveProgress').style.width = '100%';
        const failed = (payload.thresholds || []).filter((t) => !t.passed).length;
        toast('Run finished: ' + payload.status + (failed ? ' - ' + failed + ' SLA breach(es)' : ''), failed ? 'bad' : 'ok');
        loadRuns();
        checkHealth();
      }
    };

    socket.onclose = () => setTimeout(connect, 2000);
  }

  async function loadPresets() {
    try {
      const data = await api('/api/presets');
      if (data.presets && data.presets.length) {
        PRESETS = data.presets;
        renderPresets();
      }
    } catch (e) { /* keep the built-in list */ }
  }

  async function checkHealth() {
    try {
      const health = await api('/api/health');
      const chip = $('k6Chip');
      chip.className = 'env-chip ' + (health.ok ? 'ok' : 'bad');
      $('k6ChipText').textContent = health.ok ? health.k6 : 'k6 not found';
      $('btnK6Dash').href = health.dashboardUrl;
      if (!health.ok) {
        toast('k6 was not found on PATH. Install it, or set K6_PATH to the k6.exe location.', 'bad');
      }
    } catch (e) {
      $('k6Chip').className = 'env-chip bad';
      $('k6ChipText').textContent = 'server unreachable';
    }
  }

  // ---------------------------------------------------------------- escaping

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------- boot

  restore();
  renderPresets();
  loadPresets();
  profileToForm();
  renderStages();
  renderRequests();
  renderVariables();
  renderRamp();
  initCharts();
  setRunning(false);
  checkHealth();
  connect();
  loadRuns();
})();
