'use strict';
/** Opens a URL in the desktop browser, preferring Chrome when it is present. */

const { spawn } = require('child_process');

function launch(command, args) {
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    child.on('error', () => {});
    return true;
  } catch (err) {
    return false;
  }
}

function openInBrowser(url) {
  if (process.env.K6LAB_OPEN === '0' || process.env.NO_OPEN) return false;

  if (process.platform === 'win32') {
    // `start chrome` falls back to a plain start if Chrome is not registered.
    return (
      launch('cmd', ['/c', 'start', '""', 'chrome', url]) ||
      launch('cmd', ['/c', 'start', '""', url])
    );
  }
  if (process.platform === 'darwin') {
    return launch('open', ['-a', 'Google Chrome', url]) || launch('open', [url]);
  }
  return (
    launch('google-chrome', [url]) ||
    launch('chromium', [url]) ||
    launch('xdg-open', [url])
  );
}

module.exports = { openInBrowser };
