'use strict';
/**
 * Trades dashboard server.
 *
 *   GET /                 the dashboard (static)
 *   GET /api/trades       paged, searchable view of the store (instant, never waits on a pull)
 *   GET /api/status       current pull state + stats
 *   GET /api/events       Server-Sent Events: `status` and `trades` pushed to open dashboards
 *   GET /healthz
 *
 * The HTTP handlers only ever read the in-memory store, so the page opens
 * instantly even while a 15-minute pull is in flight. The Puller writes to the
 * store when a pull completes and the SSE hub pushes the new trades to browsers.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { TradeStore } = require('./lib/store');
const { Puller } = require('./lib/puller');

const cfg = {
  port: Number(process.env.PORT || 3000),
  bseUrl: process.env.BSE_URL || 'http://localhost:4001',
  dataFile: process.env.DATA_FILE || path.join(__dirname, 'data', 'trades.json'),
  minGapMs: Number(process.env.PULL_MIN_GAP_MS ?? 1000),
  heartbeatMs: 20000,
};

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const store = new TradeStore(cfg.dataFile);
const puller = new Puller({ store, bseUrl: cfg.bseUrl, minGapMs: cfg.minGapMs });

/* ---------- SSE hub ---------- */
const clients = new Set();

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of clients) sseSend(res, event, data);
}

puller.on('status', (snap) => broadcast('status', snap));
puller.on('trades', (payload) => broadcast('trades', payload));

setInterval(() => {
  for (const res of clients) res.write(': keep-alive\n\n'); // stops proxies closing an idle stream
}, cfg.heartbeatMs).unref();

/* ---------- helpers ---------- */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(filePath, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/* ---------- routes ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });

  switch (url.pathname) {
    case '/api/trades': {
      const page = Number.parseInt(url.searchParams.get('page') || '1', 10) || 1;
      const pageSize = Number.parseInt(url.searchParams.get('pageSize') || '50', 10) || 50;
      return sendJson(res, 200, store.query({ q: url.searchParams.get('q') || '', page, pageSize }));
    }
    case '/api/status':
      return sendJson(res, 200, puller.snapshot());
    case '/api/events': {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      sseSend(res, 'status', puller.snapshot()); // new subscribers get the current state straight away
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return undefined;
    }
    case '/healthz':
      return sendJson(res, 200, { ok: true, trades: store.size, pull: puller.state.status });
    default:
      return serveStatic(req, res, url.pathname);
  }
});

server.listen(cfg.port, () => {
  console.log(`[dashboard] http://localhost:${cfg.port}  (BSE API: ${cfg.bseUrl})`);
  puller.start(); // the first pull begins immediately; the page does not wait for it
});

function shutdown() {
  puller.stop();
  store.save();
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);
