'use strict';
/**
 * End-to-end test of the behaviour the brief asks for, with a short pull delay:
 *   1. a pull completes and its trades are pushed to an open SSE stream
 *   2. while the next pull is still in flight, the dashboard opens instantly with the trades already pulled
 *   3. when that pull completes, new trades reach the open stream with no browser request in between
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const MOCK_PORT = 4611;
const DASH_PORT = 4612;
const PULL_DELAY_MS = 1500;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-pulse-'));
const children = [];

function start(script, env) {
  const child = spawn(process.execPath, [path.join(root, script)], { env: { ...process.env, ...env }, stdio: 'ignore' });
  children.push(child);
  return child;
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const began = Date.now();
    http.get({ port, path: urlPath, host: '127.0.0.1' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - began, text: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

async function waitFor(fn, { timeoutMs = 8000, everyMs = 50, label = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* keep trying */ }
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Minimal SSE client that records every event it receives. */
function openStream(port) {
  const events = [];
  const req = http.get({ port, path: '/api/events', host: '127.0.0.1' }, (res) => {
    let buf = '';
    res.on('error', () => {}); // closing the stream on purpose raises ECONNRESET; that is expected
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = /^event: (.+)$/m.exec(block);
        const data = /^data: (.+)$/m.exec(block);
        if (ev && data) events.push({ at: Date.now(), event: ev[1], data: JSON.parse(data[1]) });
      }
    });
  });
  req.on('error', () => {});
  return { events, close: () => req.destroy() };
}

test.before(async () => {
  start('mock-bse/server.js', {
    PORT: String(MOCK_PORT),
    PULL_DELAY_MS: String(PULL_DELAY_MS),
    GROWTH_INTERVAL_MS: '250',
    SEED_TRADES: '3000',
    STATE_FILE: path.join(tmp, 'mock-state.json'),
  });
  start('dashboard/server.js', {
    PORT: String(DASH_PORT),
    BSE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    DATA_FILE: path.join(tmp, 'trades.json'),
    PULL_MIN_GAP_MS: '0',
  });
  await waitFor(async () => (await get(MOCK_PORT, '/health')).status === 200, { label: 'mock BSE' });
  await waitFor(async () => (await get(DASH_PORT, '/healthz')).status === 200, { label: 'dashboard' });
});

test.after(async () => {
  // Wait for both servers to exit before deleting their data: the dashboard may be mid-snapshot.
  await Promise.all(children.map((c) => new Promise((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) return resolve();
    c.once('exit', resolve);
    c.kill('SIGTERM');
    setTimeout(() => { c.kill('SIGKILL'); resolve(); }, 2000).unref();
  })));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('mock BSE: seeded data, shape and configurable delay', async () => {
  const r = await get(MOCK_PORT, '/getTrades?delayMs=0');
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.ok(body.trades.length >= 3000, `expected a few thousand trades, got ${body.trades.length}`);
  for (const key of ['tradeId', 'client', 'symbol', 'quantity', 'price', 'timestamp']) {
    assert.ok(key in body.trades[0], `trade is missing ${key}`);
  }
  const again = JSON.parse((await get(MOCK_PORT, '/getTrades?delayMs=0')).text);
  assert.deepEqual(again.trades.slice(0, 50), body.trades.slice(0, 50), 'seeded data must be deterministic');

  const slow = await get(MOCK_PORT, '/getTrades?delayMs=700');
  assert.ok(slow.ms >= 650, `delay was not honoured (${slow.ms}ms)`);
});

test('pull results are pushed to an open dashboard, and the page is instant mid-pull', async () => {
  const stream = openStream(DASH_PORT);
  try {
    // 1. First pull completes and is pushed.
    const first = await waitFor(() => stream.events.find((e) => e.event === 'trades'), { timeoutMs: 6000, label: 'first trades event' });
    assert.ok(first.data.added >= 3000, `first pull should bring the seeded trades, got ${first.data.added}`);

    // 2. A second pull is now in flight. The dashboard must open instantly and already show trades.
    const status = await waitFor(async () => {
      const s = JSON.parse((await get(DASH_PORT, '/api/status')).text);
      return s.status === 'pulling' ? s : null;
    }, { label: 'a pull in progress' });
    assert.equal(status.status, 'pulling');

    const page = await get(DASH_PORT, '/');
    assert.equal(page.status, 200);
    assert.ok(page.ms < 300, `page took ${page.ms}ms to load during a pull`);

    const list = await get(DASH_PORT, '/api/trades?page=1&pageSize=50');
    const data = JSON.parse(list.text);
    assert.ok(list.ms < 300, `trade list took ${list.ms}ms during a pull`);
    assert.equal(data.trades.length, 50);
    assert.ok(data.total >= 3000);

    // 3. The next completion arrives on the same open stream, with no request from the client.
    const seenBefore = stream.events.filter((e) => e.event === 'trades').length;
    const next = await waitFor(() => {
      const all = stream.events.filter((e) => e.event === 'trades');
      return all.length > seenBefore ? all[all.length - 1] : null;
    }, { timeoutMs: 6000, label: 'second trades event' });
    assert.ok(next.data.added >= 1, 'second pull should add new trades');
    assert.ok(next.data.total > data.total, 'total should have grown');

    const ids = new Set(next.data.trades.map((t) => t.tradeId));
    assert.equal(ids.size, next.data.trades.length, 'pushed trades must be unique');
    const after = JSON.parse((await get(DASH_PORT, '/api/trades?page=1&pageSize=5')).text);
    assert.equal(after.trades[0].tradeId, next.data.trades[0].tradeId, 'store and pushed batch agree on the newest trade');
  } finally {
    stream.close();
  }
});

test('no duplicate trades after several pulls', async () => {
  const all = JSON.parse((await get(DASH_PORT, '/api/trades?page=1&pageSize=200&q=BSE-')).text);
  const ids = all.trades.map((t) => t.tradeId);
  assert.equal(new Set(ids).size, ids.length);
});
