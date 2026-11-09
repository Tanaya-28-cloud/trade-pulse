'use strict';
/**
 * Mock BSE API
 *
 *   GET /getTrades[?afterCursor=<cursor>][&delayMs=<ms>]
 *   GET /config
 *   GET /health
 *
 * - Serves deterministic, seeded trade data (SEED_TRADES records up front, then
 *   a new trade every GROWTH_INTERVAL_MS so repeated pulls keep finding new data).
 * - /getTrades answers only after PULL_DELAY_MS (default 15 minutes) to mimic a
 *   slow exchange pull. The delay is configurable via env or ?delayMs=.
 * - The snapshot is computed when the delay elapses, so a 15-minute pull returns
 *   the data as of the moment it completes.
 *
 * Zero dependencies: Node 20+ only.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const cfg = {
  port: Number(process.env.PORT || 4001),
  pullDelayMs: Number(process.env.PULL_DELAY_MS ?? 15 * 60 * 1000),
  seed: Number(process.env.SEED ?? 20261108),
  seedTrades: Number(process.env.SEED_TRADES ?? 3000),
  growthIntervalMs: Number(process.env.GROWTH_INTERVAL_MS ?? 20000),
  stateFile: process.env.STATE_FILE || path.join(__dirname, 'state.json'),
};

const SEED_SESSION_MS = 8 * 60 * 60 * 1000; // seeded history spans 8 hours before the anchor

const SYMBOLS = [
  ['RELIANCE', 2950], ['TCS', 4100], ['HDFCBANK', 1680], ['INFY', 1850], ['ICICIBANK', 1210],
  ['SBIN', 840], ['BHARTIARTL', 1520], ['ITC', 465], ['LT', 3650], ['HINDUNILVR', 2410],
  ['KOTAKBANK', 1790], ['AXISBANK', 1180], ['ASIANPAINT', 2890], ['MARUTI', 12400], ['SUNPHARMA', 1760],
  ['TITAN', 3480], ['BAJFINANCE', 7150], ['WIPRO', 560], ['ONGC', 275], ['NTPC', 385],
];

const CLIENTS = [
  'Meridian Wealth', 'Orion Capital', 'Kestrel Securities', 'Banyan Asset Mgmt', 'Saffron Investments',
  'Lotus Family Office', 'Harbor Point Fund', 'Deccan Equity Partners', 'Indus Growth Fund', 'Monsoon Trading Co',
  'Vega Proprietary', 'Atlas Pension Trust', 'Zenith Brokerage', 'Coral Reef Capital', 'Mandala Holdings',
  'Peak Ridge Advisors', 'Sundial Funds', 'Tiger Lily Investments', 'Aurora Mutual', 'Granite Bay Capital',
  'Silk Route Partners', 'Northstar Wealth', 'Bluewater Trading', 'Ember Securities', 'Cobalt Asset Mgmt',
];

/** Small, fast, seedable PRNG. */
function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The anchor is the moment the mock first started; persisted so ids/timestamps are stable across restarts. */
function loadAnchor() {
  try {
    const saved = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
    if (Number.isFinite(saved.anchor)) return saved.anchor;
  } catch { /* first run */ }
  const anchor = Date.now();
  try { fs.writeFileSync(cfg.stateFile, JSON.stringify({ anchor })); } catch { /* read-only fs is fine */ }
  return anchor;
}
const ANCHOR = loadAnchor();
const SEED_STEP_MS = SEED_SESSION_MS / cfg.seedTrades;

/** Number of the newest trade that exists at `now`. */
function latestSeq(now) {
  const grown = Math.max(0, Math.floor((now - ANCHOR) / cfg.growthIntervalMs));
  return cfg.seedTrades + grown;
}

function timestampOf(seq) {
  if (seq <= cfg.seedTrades) return Math.round(ANCHOR - 1000 - (cfg.seedTrades - seq) * SEED_STEP_MS);
  return ANCHOR + (seq - cfg.seedTrades) * cfg.growthIntervalMs;
}

/** Trade `seq` is a pure function of (seed, seq): same input, same record. */
function tradeAt(seq) {
  const rng = mulberry32((cfg.seed ^ Math.imul(seq, 0x9e3779b1)) >>> 0);
  const [symbol, basePrice] = SYMBOLS[Math.floor(Math.pow(rng(), 1.4) * SYMBOLS.length)];
  const client = CLIENTS[Math.floor(rng() * CLIENTS.length)];
  const quantity = (1 + Math.floor(Math.pow(rng(), 2.2) * 400)) * 5; // 5..2000 in lots of 5
  const price = Math.round(basePrice * (1 + (rng() - 0.5) * 0.04) * 100) / 100;
  return {
    tradeId: `BSE-${String(seq).padStart(8, '0')}`,
    client,
    symbol,
    quantity,
    price,
    timestamp: new Date(timestampOf(seq)).toISOString(),
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

function handleGetTrades(req, res, url) {
  const requested = url.searchParams.get('delayMs');
  const delayMs = requested !== null && Number.isFinite(Number(requested)) ? Math.max(0, Number(requested)) : cfg.pullDelayMs;
  const afterParam = Number.parseInt(url.searchParams.get('afterCursor') || '0', 10) || 0;
  const startedAt = Date.now();
  console.log(`[mock-bse] pull started (afterCursor=${afterParam || '-'}, delay=${delayMs}ms)`);

  const timer = setTimeout(() => {
    const last = latestSeq(Date.now());
    const after = afterParam > last ? 0 : afterParam; // unknown cursor => full resync
    const trades = [];
    for (let seq = after + 1; seq <= last; seq++) trades.push(tradeAt(seq));
    console.log(`[mock-bse] pull finished in ${Date.now() - startedAt}ms, returning ${trades.length} trades`);
    sendJson(res, 200, {
      source: 'mock-bse',
      generatedAt: new Date().toISOString(),
      count: trades.length,
      cursor: String(last),
      trades,
    });
  }, delayMs);

  // If the caller gives up, stop the pending response.
  res.on('close', () => {
    if (!res.writableEnded) {
      clearTimeout(timer);
      console.log('[mock-bse] client disconnected before the pull finished');
    }
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/getTrades') return handleGetTrades(req, res, url);
  if (req.method === 'GET' && url.pathname === '/config') {
    return sendJson(res, 200, {
      pullDelayMs: cfg.pullDelayMs,
      seedTrades: cfg.seedTrades,
      growthIntervalMs: cfg.growthIntervalMs,
      tradesAvailableNow: latestSeq(Date.now()),
    });
  }
  if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true });
  return sendJson(res, 404, { error: 'not found' });
});

// A pull can legitimately take 15 minutes: never time the socket out.
server.timeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 5000;

server.listen(cfg.port, () => {
  console.log(`[mock-bse] listening on http://localhost:${cfg.port}`);
  console.log(`[mock-bse] GET /getTrades answers after ${cfg.pullDelayMs}ms; ${cfg.seedTrades} seeded trades, +1 every ${cfg.growthIntervalMs}ms`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
