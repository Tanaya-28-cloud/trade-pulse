'use strict';
/**
 * Puller: runs the (very slow) BSE pull in the background.
 *
 * There is no cron, no scheduler and no browser polling. A pull is one long
 * HTTP request; when it completes the next one starts straight away, so exactly
 * one pull is in flight at any time. Completion is the event that drives the UI:
 * the puller emits 'trades', the server fans it out to every open SSE stream.
 *
 * Implementation notes:
 *  - node:http is used instead of global fetch on purpose. fetch (undici) aborts
 *    a request that has not produced response headers within 5 minutes, which
 *    would break a 15-minute pull. node:http has no such default.
 *  - Each pull sends the cursor from the previous one, so only new trades are
 *    transferred. Inserts are idempotent anyway.
 *  - setTimeout is used only for the failure backoff and a small minimum gap
 *    between pulls (protects the exchange if the mock delay is set to ~0).
 */
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getJson(target, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(target, { headers: { Accept: 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`BSE API responded ${res.statusCode}`));
        try { resolve(JSON.parse(text)); } catch { reject(new Error('BSE API returned invalid JSON')); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
  });
}

class Puller extends EventEmitter {
  constructor({ store, bseUrl, minGapMs = 1000 }) {
    super();
    this.store = store;
    this.bseUrl = bseUrl;
    this.minGapMs = minGapMs;
    this.running = false;
    this.failures = 0;
    this.state = {
      status: 'idle', // idle | pulling | error
      startedAt: null,
      expectedMs: null,
      lastError: null,
    };
  }

  snapshot() {
    return {
      now: Date.now(),
      ...this.state,
      lastPull: this.store.lastPull,
      total: this.store.size,
      stats: this.store.stats(),
    };
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('status', this.snapshot());
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
  }

  async _loop() {
    while (this.running) {
      const began = Date.now();
      try {
        await this._pullOnce();
        this.failures = 0;
      } catch (err) {
        this.failures += 1;
        const backoff = Math.min(30000, 1000 * 2 ** this.failures);
        console.warn(`[puller] pull failed: ${err.message}. Retrying in ${backoff}ms`);
        this._set({ status: 'error', startedAt: null, lastError: { message: err.message, at: Date.now() } });
        await sleep(backoff);
        continue;
      }
      const spent = Date.now() - began;
      if (spent < this.minGapMs) await sleep(this.minGapMs - spent);
    }
  }

  /** Best-effort hint so the UI can show "3:10 of 15:00". Not required for correctness. */
  async _fetchExpectedMs() {
    try {
      const cfg = await getJson(new URL('/config', this.bseUrl), { timeoutMs: 2000 });
      return Number.isFinite(cfg.pullDelayMs) ? cfg.pullDelayMs : null;
    } catch {
      return null;
    }
  }

  async _pullOnce() {
    const startedAt = Date.now();
    const expectedMs = await this._fetchExpectedMs();
    this._set({ status: 'pulling', startedAt, expectedMs, lastError: null });

    const target = new URL('/getTrades', this.bseUrl);
    if (this.store.cursor) target.searchParams.set('afterCursor', this.store.cursor);
    console.log(`[puller] pull started${this.store.cursor ? ` (cursor ${this.store.cursor})` : ' (initial)'}`);

    const body = await getJson(target);
    const received = Array.isArray(body.trades) ? body.trades.length : 0;
    const inserted = this.store.add(body.trades);
    if (body.cursor) this.store.cursor = String(body.cursor);

    const completedAt = Date.now();
    this.store.lastPull = { startedAt, completedAt, durationMs: completedAt - startedAt, received, added: inserted.length };
    this.store.save();
    console.log(`[puller] pull complete in ${this.store.lastPull.durationMs}ms: ${received} received, ${inserted.length} new, ${this.store.size} total`);

    this._set({ status: 'idle', startedAt: null });
    if (inserted.length) {
      this.emit('trades', {
        now: completedAt,
        added: inserted.length,
        trades: inserted.slice(0, 200), // newest first; the browser refetches if it needs more
        total: this.store.size,
        stats: this.store.stats(),
        lastPull: this.store.lastPull,
      });
    }
  }
}

module.exports = { Puller };
