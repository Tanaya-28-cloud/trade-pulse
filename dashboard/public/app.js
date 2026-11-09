(() => {
  'use strict';

  // Trade Pulse Preloader
  const preloader = document.getElementById('preloader');

  window.addEventListener('load', () => {
    setTimeout(() => {
      preloader?.classList.add('hide');

      setTimeout(() => {
        preloader?.remove();
      }, 500);

    }, 1000);
  });

  const $ = (id) => document.getElementById(id);
  const el = {
    conn: $('conn'), connText: $('connText'),
    pullCard: $('pullCard'), pullLabel: $('pullLabel'), pullSub: $('pullSub'), pullClock: $('pullClock'),
    bar: $('bar'), barFill: $('barFill'), lastPull: $('lastPull'),
    kTrades: $('kTrades'), kTurnover: $('kTurnover'), kClients: $('kClients'), kSymbols: $('kSymbols'),
    search: $('search'), range: $('range'), banner: $('banner'), bannerText: $('bannerText'), bannerBtn: $('bannerBtn'),
    rows: $('rows'), empty: $('empty'), prev: $('prev'), next: $('next'), pageInfo: $('pageInfo'), toast: $('toast'),
  };

  const state = {
    page: 1,
    pageSize: 50,
    q: '',
    rows: [],
    filtered: 0,
    total: 0,
    pages: 1,
    stats: null,
    pull: null,
    lastPull: null,
    skew: 0, // server clock minus browser clock, so the pull timer is right even if clocks differ
    pending: 0, // new trades that arrived while the user is not looking at page 1
    fresh: new Set(),
    needsResync: false,
    loadSeq: 0,
  };

  const fmtInt = new Intl.NumberFormat('en-IN');
  const fmtPrice = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtTime = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  function money(n) {
    if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
    if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
    return `₹${fmtPrice.format(n)}`;
  }

  function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() + state.skew - ts) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }

  /* ---------- rendering ---------- */
  function cell(tag, text, cls) {
    const td = document.createElement(tag);
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  }

  function renderRows() {
    const frag = document.createDocumentFragment();
    for (const t of state.rows) {
      const tr = document.createElement('tr');
      if (state.fresh.has(t.tradeId)) tr.className = 'is-new';
      tr.append(
        cell('td', t.tradeId, 'id'),
        cell('td', t.client),
        cell('td', t.symbol, 'sym'),
        cell('td', fmtInt.format(t.quantity), 'num'),
        cell('td', fmtPrice.format(t.price), 'num'),
        cell('td', fmtPrice.format(t.quantity * t.price), 'num'),
        cell('td', fmtTime.format(new Date(t.timestamp)), 'time'),
      );
      frag.append(tr);
    }
    el.rows.replaceChildren(frag);

    const none = state.rows.length === 0;
    el.empty.hidden = !none;
    if (none) {
      if (state.q) el.empty.textContent = 'No trades match your search.';
      else if (state.pull && state.pull.status === 'pulling') el.empty.textContent = 'No trades yet. The first pull from BSE is in progress; trades will appear here the moment it completes.';
      else el.empty.textContent = 'No trades yet.';
    }

    const from = state.filtered ? (state.page - 1) * state.pageSize + 1 : 0;
    const to = Math.min(state.page * state.pageSize, state.filtered);
    el.range.textContent = state.filtered ? `${fmtInt.format(from)}–${fmtInt.format(to)} of ${fmtInt.format(state.filtered)}${state.q ? ' matches' : ' trades'}` : '';
    el.pageInfo.textContent = `Page ${state.page} of ${state.pages}`;
    el.prev.disabled = state.page <= 1;
    el.next.disabled = state.page >= state.pages;
  }

  function renderKpis() {
    const s = state.stats;
    if (!s) return;
    el.kTrades.textContent = fmtInt.format(s.trades);
    el.kTurnover.textContent = money(s.turnover);
    el.kClients.textContent = fmtInt.format(s.clients);
    el.kSymbols.textContent = fmtInt.format(s.symbols);
  }

  function renderBanner() {
    el.banner.hidden = state.pending === 0;
    if (state.pending) el.bannerText.textContent = `${fmtInt.format(state.pending)} new trade${state.pending === 1 ? '' : 's'} arrived`;
  }

  function renderPull() {
    const p = state.pull;
    if (!p) return;
    el.pullCard.dataset.state = p.status;
    el.bar.classList.remove('indeterminate');

    if (p.status === 'pulling' && p.startedAt) {
      const elapsed = Date.now() + state.skew - p.startedAt;
      el.pullLabel.textContent = 'Pull in progress';
      if (p.expectedMs) {
        const pct = Math.min(99, (elapsed / p.expectedMs) * 100);
        if (state.barPullStart !== p.startedAt) {
          // A new pull began: snap the bar back to the start instead of animating it backwards.
          state.barPullStart = p.startedAt;
          el.barFill.style.transition = 'none';
          el.barFill.style.width = '0%';
          void el.barFill.offsetWidth; // force reflow so the reset is applied before the transition returns
          el.barFill.style.transition = '';
        }
        el.barFill.style.width = `${pct}%`;
        el.pullClock.innerHTML = `${clock(elapsed)} <small>/ ${clock(p.expectedMs)}</small>`;
        el.pullSub.textContent = 'Fetching the latest trades from BSE. The dashboard stays fully usable meanwhile.';
      } else {
        el.bar.classList.add('indeterminate');
        el.pullClock.textContent = clock(elapsed);
        el.pullSub.textContent = 'Fetching the latest trades from BSE. The dashboard stays fully usable meanwhile.';
      }
    } else if (p.status === 'error') {
      el.pullLabel.textContent = 'Last pull failed. Retrying automatically';
      el.pullSub.textContent = p.lastError ? p.lastError.message : '';
      el.pullClock.textContent = '';
    } else {
      el.pullLabel.textContent = 'Pull complete';
      el.pullSub.textContent = 'Starting the next pull…';
      el.pullClock.textContent = '';
    }

    const lp = state.lastPull;
    el.lastPull.textContent = lp
      ? `Last pull completed ${ago(lp.completedAt)} in ${clock(lp.durationMs)}: ${fmtInt.format(lp.received)} received, ${fmtInt.format(lp.added)} new.`
      : 'No pull has completed yet.';
  }

  /* ---------- data ---------- */
  async function loadPage() {
    const seq = ++state.loadSeq;
    const qs = new URLSearchParams({ page: state.page, pageSize: state.pageSize, q: state.q });
    try {
      const res = await fetch(`/api/trades?${qs}`);
      const data = await res.json();
      if (seq !== state.loadSeq) return; // a newer request superseded this one
      state.rows = data.trades;
      state.page = data.page;
      state.pages = data.pages;
      state.filtered = data.filtered;
      state.total = data.total;
      renderRows();
    } catch {
      /* the connection indicator already tells the user; a retry happens on reconnect */
    }
  }

  function applyStatus(s) {
    state.skew = s.now - Date.now();
    state.pull = s;
    if (s.lastPull) state.lastPull = s.lastPull;
    if (s.stats) { state.stats = s.stats; renderKpis(); }
    renderPull();
  }

  function onTrades(ev) {
    state.skew = ev.now - Date.now();
    state.stats = ev.stats;
    state.total = ev.total;
    state.lastPull = ev.lastPull;
    renderKpis();

    const onLatest = state.page === 1 && state.q === '';
    if (onLatest) {
      const known = new Set(state.rows.map((t) => t.tradeId));
      const incoming = ev.trades.filter((t) => !known.has(t.tradeId));
      state.fresh = new Set(incoming.map((t) => t.tradeId));
      state.rows = incoming.concat(state.rows).slice(0, state.pageSize);
      state.filtered = ev.total;
      state.pages = Math.max(1, Math.ceil(ev.total / state.pageSize));
      renderRows();
    } else {
      state.pending += ev.added;
      renderBanner();
    }
    toast(`+${fmtInt.format(ev.added)} new trade${ev.added === 1 ? '' : 's'} from BSE`);
    renderPull();
  }

  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 4000);
  }

  /* ---------- live stream (Server-Sent Events: no polling) ---------- */
  function connect() {
    const es = new EventSource('/api/events');
    es.onopen = () => {
      el.conn.dataset.state = 'live';
      el.connText.textContent = 'Live';
      if (state.needsResync) { state.needsResync = false; loadPage(); } // catch up on anything missed while offline
    };
    es.onerror = () => {
      el.conn.dataset.state = 'down';
      el.connText.textContent = 'Reconnecting…';
      state.needsResync = true; // EventSource retries by itself
    };
    es.addEventListener('status', (e) => applyStatus(JSON.parse(e.data)));
    es.addEventListener('trades', (e) => onTrades(JSON.parse(e.data)));
  }

  /* ---------- UI wiring ---------- */
  let searchTimer;
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = el.search.value.trim();
      state.page = 1;
      state.pending = 0;
      renderBanner();
      loadPage();
    }, 220);
  });
  el.prev.addEventListener('click', () => { state.page -= 1; loadPage(); });
  el.next.addEventListener('click', () => { state.page += 1; loadPage(); });
  el.bannerBtn.addEventListener('click', () => {
    state.page = 1;
    state.q = '';
    el.search.value = '';
    state.pending = 0;
    renderBanner();
    loadPage();
  });

  // Local-only tick so the elapsed time and "x ago" labels move. It makes no network calls.
  setInterval(renderPull, 1000);

  loadPage(); // show whatever has already been pulled, immediately
  connect();
})();
