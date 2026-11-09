
'use strict';

/**
 * Trades dashboard server.
 *
 *   GET /                 the dashboard (static)
 *   GET /api/trades       paged, searchable view of the store
 *   GET /api/status       current pull state + stats
 *   GET /api/events       Server-Sent Events: status and trades
 *   GET /healthz          health check
 *
 * Supports cross-origin requests from the Vercel frontend.
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
  allowedOrigin: process.env.FRONTEND_ORIGIN || '*',
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
const puller = new Puller({
  store,
  bseUrl: cfg.bseUrl,
  minGapMs: cfg.minGapMs,
});

/* ---------- SSE hub ---------- */

const clients = new Set();

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of clients) {
    if (!res.destroyed) {
      sseSend(res, event, data);
    }
  }
}

puller.on('status', (snap) => broadcast('status', snap));
puller.on('trades', (payload) => broadcast('trades', payload));

setInterval(() => {
  for (const res of clients) {
    if (!res.destroyed) {
      res.write(': keep-alive\n\n');
    }
  }
}, cfg.heartbeatMs).unref();

/* ---------- helpers ---------- */

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', cfg.allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

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

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      return sendJson(res, 404, { error: 'not found' });
    }

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
  setCorsHeaders(res);

  // Handle browser CORS preflight requests.
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  switch (url.pathname) {
    case '/api/trades': {
      const page =
        Number.parseInt(url.searchParams.get('page') || '1', 10) || 1;

      const pageSize =
        Number.parseInt(url.searchParams.get('pageSize') || '50', 10) || 50;

      return sendJson(
        res,
        200,
        store.query({
          q: url.searchParams.get('q') || '',
          page,
          pageSize,
        })
      );
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

      sseSend(res, 'status', puller.snapshot());

      clients.add(res);

      // Remove disconnected SSE clients.
      res.on('close', () => {
        clients.delete(res);
      });

      return undefined;
    }

    case '/healthz':
      return sendJson(res, 200, {
        ok: true,
        trades: store.size,
        pull: puller.state.status,
      });

    default:
      return serveStatic(req, res, url.pathname);
  }
});

/* ---------- startup ---------- */

server.listen(cfg.port, '0.0.0.0', () => {
  console.log(
    `[dashboard] listening on port ${cfg.port} (BSE API: ${cfg.bseUrl})`
  );

  puller.start();
});

/* ---------- graceful shutdown ---------- */

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('[dashboard] shutting down...');

  puller.stop();
  store.save();

  for (const res of clients) {
    res.end();
  }

  clients.clear();

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 500).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, shutdown);
}
