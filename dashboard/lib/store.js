'use strict';
/**
 * Trade store: the single source of truth for the dashboard.
 *
 * Keeps trades in memory (sorted newest first) and snapshots them to a JSON file
 * after every completed pull, so a restart opens instantly with everything that
 * was already pulled. Inserts are idempotent (keyed by tradeId), which makes
 * retried or overlapping pulls harmless.
 *
 * For a real deployment, swap this class for SQLite/Postgres: the interface
 * (add, query, stats, cursor, lastPull, save) is all the rest of the app uses.
 */
const fs = require('node:fs');
const path = require('node:path');

class TradeStore {
  constructor(file) {
    this.file = file;
    this.byId = new Map();
    this.list = []; // newest first
    this.cursor = null; // opaque cursor returned by the BSE API
    this.lastPull = null;
    this._stats = null;
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const t of raw.trades || []) this.byId.set(t.tradeId, t);
      this.list = [...this.byId.values()];
      this._sort();
      this.cursor = raw.cursor ?? null;
      this.lastPull = raw.lastPull ?? null;
      console.log(`[store] loaded ${this.list.length} trades from ${this.file}`);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[store] could not read ${this.file}: ${err.message}`);
    }
  }

  _sort() {
    this.list.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.tradeId.localeCompare(a.tradeId));
  }

  get size() {
    return this.list.length;
  }

  /** Insert-or-ignore. Returns only the trades that were actually new, newest first. */
  add(trades) {
    const inserted = [];
    for (const t of trades || []) {
      if (!t || typeof t.tradeId !== 'string' || typeof t.timestamp !== 'string') continue;
      if (this.byId.has(t.tradeId)) continue;
      const trade = {
        tradeId: t.tradeId,
        client: String(t.client),
        symbol: String(t.symbol),
        quantity: Number(t.quantity),
        price: Number(t.price),
        timestamp: t.timestamp,
      };
      this.byId.set(trade.tradeId, trade);
      inserted.push(trade);
    }
    if (inserted.length) {
      this.list.push(...inserted);
      this._sort();
      this._stats = null;
      inserted.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.tradeId.localeCompare(a.tradeId));
    }
    return inserted;
  }

  query({ q = '', page = 1, pageSize = 50 } = {}) {
    const needle = q.trim().toLowerCase();
    const rows = needle
      ? this.list.filter((t) => t.tradeId.toLowerCase().includes(needle) || t.client.toLowerCase().includes(needle) || t.symbol.toLowerCase().includes(needle))
      : this.list;
    const size = Math.min(Math.max(1, pageSize), 200);
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const current = Math.min(Math.max(1, page), pages);
    return {
      trades: rows.slice((current - 1) * size, current * size),
      page: current,
      pageSize: size,
      pages,
      filtered: rows.length,
      total: this.list.length,
    };
  }

  stats() {
    if (this._stats) return this._stats;
    let turnover = 0;
    const clients = new Set();
    const symbols = new Set();
    for (const t of this.list) {
      turnover += t.quantity * t.price;
      clients.add(t.client);
      symbols.add(t.symbol);
    }
    this._stats = {
      trades: this.list.length,
      turnover: Math.round(turnover * 100) / 100,
      clients: clients.size,
      symbols: symbols.size,
      latestTradeAt: this.list[0]?.timestamp ?? null,
    };
    return this._stats;
  }

  /** Atomic snapshot: write a temp file, then rename over the real one. */
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ cursor: this.cursor, lastPull: this.lastPull, trades: this.list }));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`[store] snapshot failed: ${err.message}`);
    }
  }
}

module.exports = { TradeStore };
