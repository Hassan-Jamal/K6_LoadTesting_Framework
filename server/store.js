'use strict';
/** Filesystem-backed catalogue of runs. One directory per run inside the runs dir. */

const fs = require('fs');
const path = require('path');

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.runsDir = dataDir;
    fs.mkdirSync(this.runsDir, { recursive: true });
  }

  runDir(id) {
    // Run ids are generated server-side, but never trust one off the wire.
    const safe = String(id).replace(/[^A-Za-z0-9._-]/g, '');
    if (!safe || safe !== String(id)) throw new Error('Invalid run id');
    return path.join(this.runsDir, safe);
  }

  list() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.runsDir, { withFileTypes: true });
    } catch (e) {
      return [];
    }
    const runs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.runsDir, entry.name);
      const result = readJson(path.join(dir, 'result.json'));
      const meta = readJson(path.join(dir, 'meta.json'));
      if (!result && !meta) continue;
      runs.push({
        id: entry.name,
        name: (result && result.name) || (meta && meta.name) || entry.name,
        status: result ? result.status : 'incomplete',
        startedAt: (result && result.startedAt) || (meta && meta.createdAt) || null,
        duration: result ? result.duration : null,
        totals: result ? result.totals : null,
        thresholds: result ? result.thresholds || [] : [],
        executor: (meta && meta.profile && meta.profile.executor) || null,
        hasK6Report: fs.existsSync(path.join(dir, 'k6-dashboard.html')),
      });
    }
    return runs.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  }

  get(id) {
    const dir = this.runDir(id);
    const result = readJson(path.join(dir, 'result.json'));
    const meta = readJson(path.join(dir, 'meta.json'));
    if (!result && !meta) return null;
    return Object.assign({ id }, meta || {}, result || {}, {
      hasK6Report: fs.existsSync(path.join(dir, 'k6-dashboard.html')),
    });
  }

  scriptPath(id) {
    return path.join(this.runDir(id), 'script.js');
  }

  k6ReportPath(id) {
    return path.join(this.runDir(id), 'k6-dashboard.html');
  }

  remove(id) {
    fs.rmSync(this.runDir(id), { recursive: true, force: true });
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

module.exports = { Store };
