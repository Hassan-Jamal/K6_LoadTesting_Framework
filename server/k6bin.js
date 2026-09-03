'use strict';
/**
 * Finds k6, or fetches it.
 *
 * k6 is a Go binary, not an npm package, so it cannot be a dependency. This
 * module looks for an existing install first and only downloads when there
 * isn't one - into the user's home directory, never system-wide.
 */

const { spawnSync, spawnSync: run } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const HOME_DIR = path.join(os.homedir(), '.k6lab');
const BIN_DIR = path.join(HOME_DIR, 'bin');
const EXE = process.platform === 'win32' ? 'k6.exe' : 'k6';
const MANAGED = path.join(BIN_DIR, EXE);

/** Does this path respond to `k6 version`? */
function works(candidate) {
  try {
    const res = spawnSync(candidate, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (res.error || res.status !== 0) return null;
    return String(res.stdout).trim().split('\n')[0];
  } catch (err) {
    return null;
  }
}

/**
 * Resolution order: an explicit K6_PATH, then whatever is on PATH, then the
 * copy this tool downloaded earlier.
 */
function resolveK6() {
  if (process.env.K6_PATH) {
    const version = works(process.env.K6_PATH);
    if (version) return { path: process.env.K6_PATH, version, source: 'K6_PATH' };
  }
  const onPath = works('k6');
  if (onPath) return { path: 'k6', version: onPath, source: 'PATH' };

  if (fs.existsSync(MANAGED)) {
    const version = works(MANAGED);
    if (version) return { path: MANAGED, version, source: 'managed' };
  }
  return null;
}

/** grafana/k6 publishes assets as k6-vX.Y.Z-<os>-<arch>.<ext> */
function assetFor(version) {
  const osName = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!osName || !arch) {
    throw new Error(
      'No prebuilt k6 for ' + process.platform + '/' + process.arch +
      '. Install k6 manually: https://grafana.com/docs/k6/latest/set-up/install-k6/'
    );
  }
  if (osName === 'linux' && arch === 'arm64') {
    // linux arm64 ships as tar.gz like amd64
  }
  const ext = osName === 'linux' ? 'tar.gz' : 'zip';
  const stem = 'k6-' + version + '-' + osName + '-' + arch;
  return {
    stem,
    name: stem + '.' + ext,
    url: 'https://github.com/grafana/k6/releases/download/' + version + '/' + stem + '.' + ext,
  };
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'k6-load-lab' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(getJSON(res.headers.location));
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error('Could not read the release list from GitHub'));
          }
        });
      })
      .on('error', reject);
  });
}

function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'k6-load-lab' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(download(res.headers.location, dest, onProgress));
        }
        if (res.statusCode !== 200) {
          return reject(new Error('Download failed with HTTP ' + res.statusCode));
        }
        const total = Number(res.headers['content-length'] || 0);
        let seen = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          seen += chunk.length;
          if (onProgress) onProgress(seen, total);
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

/**
 * Uses whatever unpacker the platform already has, rather than adding a
 * dependency. `tar` is tried first because Windows 10+, macOS and Linux all
 * ship a build that handles both zip and tar.gz; the others are fallbacks.
 */
function extract(archive, into) {
  const attempts = [['tar', ['-xf', archive, '-C', into]]];

  if (process.platform === 'win32') {
    attempts.push([
      'powershell',
      ['-NoProfile', '-Command', 'Expand-Archive -Path "' + archive + '" -DestinationPath "' + into + '" -Force'],
    ]);
  } else if (!archive.endsWith('.tar.gz')) {
    attempts.push(['unzip', ['-o', '-q', archive, '-d', into]]);
  }

  const failures = [];
  for (const [cmd, args] of attempts) {
    const res = run(cmd, args, { encoding: 'utf8', windowsHide: true });
    if (!res.error && res.status === 0) return;
    failures.push(cmd + ': ' + (res.error ? res.error.message : (res.stderr || 'exit ' + res.status).trim()));
  }
  throw new Error('Could not unpack the archive. Tried ' + failures.join(' | '));
}

/** Finds the k6 executable somewhere under a freshly extracted directory. */
function findExe(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === EXE) return full;
    }
  }
  return null;
}

/**
 * Downloads k6 into ~/.k6lab/bin. Returns the resolved binary info.
 * @param {(msg: string) => void} log
 * @param {string} [wanted] release tag, defaults to the latest
 */
async function installK6(log, wanted) {
  const version = wanted || (await getJSON('https://api.github.com/repos/grafana/k6/releases/latest')).tag_name;
  if (!version) throw new Error('Could not work out the latest k6 version');

  const asset = assetFor(version);
  log('Downloading k6 ' + version + ' for ' + process.platform + '/' + process.arch + '...');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'k6lab-'));
  const archive = path.join(work, asset.name);

  let lastPct = -1;
  await download(asset.url, archive, (seen, total) => {
    if (!total) return;
    const pct = Math.floor((seen / total) * 100);
    if (pct >= lastPct + 10) {
      lastPct = pct;
      log('  ' + pct + '%  (' + Math.round(seen / 1048576) + ' of ' + Math.round(total / 1048576) + ' MB)');
    }
  });

  log('Unpacking...');
  extract(archive, work);

  const found = findExe(work);
  if (!found) throw new Error('The archive did not contain a k6 executable');

  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.copyFileSync(found, MANAGED);
  if (process.platform !== 'win32') fs.chmodSync(MANAGED, 0o755);
  fs.rmSync(work, { recursive: true, force: true });

  const check = works(MANAGED);
  if (!check) throw new Error('Downloaded k6 but it would not run');
  return { path: MANAGED, version: check, source: 'managed' };
}

module.exports = { resolveK6, installK6, MANAGED, BIN_DIR };
