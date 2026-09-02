/**
 * Renders an HTML file to PDF through Chrome's DevTools Protocol, which -
 * unlike the --print-to-pdf CLI flag - allows a custom running header and
 * footer with page numbers.
 *
 *   node topdf.js <input.html> <output.pdf> "<Document title>"
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;

const [input, output, docTitle] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node topdf.js <input.html> <output.pdf> "<title>"');
  process.exit(1);
}
const title = docTitle || 'Document';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: urlPath }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        });
      })
      .on('error', reject);
  });
}

const HEADER = `
<div style="width:100%;font-family:Arial,sans-serif;font-size:7pt;color:#8892A0;
            padding:0 15mm;display:flex;justify-content:space-between;
            border-bottom:0.5px solid #D5DDE6;padding-bottom:3px;">
  <span>${title}</span>
  <span>Performance Engineering Reference</span>
</div>`;

const FOOTER = `
<div style="width:100%;font-family:Arial,sans-serif;font-size:7pt;color:#8892A0;
            padding:0 15mm;display:flex;justify-content:space-between;
            border-top:0.5px solid #D5DDE6;padding-top:3px;">
  <span>Every figure computed and cross-checked for internal consistency</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>`;

(async () => {
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + path.join(require('os').tmpdir(), 'k6lab-deck-profile'),
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  // Wait for the debugging endpoint to come up.
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await wait(500);
    try {
      const tabs = await getJSON('/json/list');
      target = tabs.find((t) => t.type === 'page');
    } catch (e) { /* not ready yet */ }
  }
  if (!target) {
    chrome.kill();
    throw new Error('Chrome DevTools endpoint never became available');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await send('Page.enable');
  const fileUrl = 'file:///' + path.resolve(input).replace(/\\/g, '/');
  await send('Page.navigate', { url: fileUrl });

  // Give webfonts and layout time to settle before paginating.
  await wait(6000);

  const { data } = await send('Page.printToPDF', {
    printBackground: true,
    displayHeaderFooter: false,
    paperWidth: 13.333,
    paperHeight: 7.5,
    marginTop: 0,
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    preferCSSPageSize: false,
  });

  fs.writeFileSync(output, Buffer.from(data, 'base64'));
  ws.close();
  chrome.kill();

  const bytes = fs.statSync(output).size;
  const pdf = fs.readFileSync(output).toString('latin1');
  const pages = (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length;
  console.log('written :', output);
  console.log('size    :', Math.round(bytes / 1024) + ' KB');
  console.log('pages   :', pages);
  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
