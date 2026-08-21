/**
 * Test target for the k6 vs JMeter comparison.
 *
 * Every response is delayed by a fixed SERVER_DELAY_MS and the work is a
 * timer rather than computation, so the target stays nearly free CPU-wise and
 * the load generator is the thing under measurement. Because the true latency
 * is known exactly, whatever each tool *reports* can be checked against it.
 */
const http = require('http');

const PORT = Number(process.env.PORT || 8099);
const SERVER_DELAY_MS = Number(process.env.DELAY || 50);

let served = 0;
let inFlight = 0;
let peakInFlight = 0;

const body = JSON.stringify({ ok: true, items: [1, 2, 3], note: 'load test target' });

const server = http.createServer((req, res) => {
  inFlight++;
  if (inFlight > peakInFlight) peakInFlight = inFlight;

  setTimeout(() => {
    served++;
    inFlight--;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Connection: 'keep-alive',
    });
    res.end(body);
  }, SERVER_DELAY_MS);
});

// Generous limits: the target must never be the constraint.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.maxRequestsPerSocket = 0; // 0 = unlimited

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('target listening on ' + PORT + ' with a ' + SERVER_DELAY_MS + 'ms fixed delay\n');
});

// Report throughput once a second so we can see what the target actually saw,
// independently of what either load generator claims.
let last = 0;
const samples = [];
setInterval(() => {
  const delta = served - last;
  last = served;
  samples.push(delta);
}, 1000).unref();

process.on('SIGTERM', dump);
process.on('SIGINT', dump);

function dump() {
  const active = samples.filter((s) => s > 0);
  const peak = active.length ? Math.max(...active) : 0;
  const avg = active.length ? active.reduce((a, b) => a + b, 0) / active.length : 0;
  process.stdout.write(
    JSON.stringify({
      servedTotal: served,
      peakRps: peak,
      avgRps: Math.round(avg),
      peakConcurrent: peakInFlight,
    }) + '\n'
  );
  process.exit(0);
}
