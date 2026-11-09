# Trade Pulse

A mock BSE trades API and a live trades dashboard. The dashboard opens instantly with everything already pulled, shows a pull in progress, and when a pull completes the new trades appear on the open page by themselves: no refresh, no browser polling, no cron job or scheduler.

```
Browser  <--HTTP + SSE-->  Dashboard server (Node)  --long-running GET-->  Mock BSE API
                           [HTTP API | SSE hub | Store | Puller]
```

There are no npm dependencies. Everything runs on Node.js 20 or newer using only built-in modules, so setup is cloning the repo and running one command.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the diagram and the reasoning behind the design.

## Quick start

Requirements: Node.js 20 or newer (`node -v` to check).

```bash
git clone <your-repo-url> trade-pulse
cd trade-pulse
npm run demo
```

Then open http://localhost:3000.

`npm run demo` starts both services together with a 20 second pull delay, which is the easiest way to see the live behaviour. To run with the real 15 minute delay use `npm start`. Any other delay works too: `DELAY_MS=60000 npm run demo`.

What you will see with the demo: the dashboard loads at once. For the first 20 seconds the table is empty and a progress bar shows the first pull running. When it completes, 3,000 seeded trades appear with no refresh. The next pull starts immediately, and 20 seconds later the handful of trades the mock has generated since then drop in at the top of the table, highlighted, with a small toast. Open the page in two tabs and both update at the same moment.

## Running the services separately

Use two terminals.

```bash
# Terminal 1: mock BSE API on :4001 (15 minute pull delay by default)
npm run mock

# Terminal 2: dashboard on :3000
npm run dashboard
```

To shorten the delay when running them separately: `PULL_DELAY_MS=20000 npm run mock`.

## The mock BSE API

`GET http://localhost:4001/getTrades` returns seeded trade data after a configurable delay (15 minutes by default).

```json
{
  "source": "mock-bse",
  "generatedAt": "2026-11-08T14:52:11.202Z",
  "count": 3001,
  "cursor": "3001",
  "trades": [
    {
      "tradeId": "BSE-00000001",
      "client": "Orion Capital",
      "symbol": "RELIANCE",
      "quantity": 380,
      "price": 2961.45,
      "timestamp": "2026-11-08T06:41:12.000Z"
    }
  ]
}
```

The data is deterministic: a seeded generator produces 3,000 historical trades, and from then on the mock creates one new trade every 20 seconds, so each later pull has something new to return. The same seed always yields the same trades.

Two optional query parameters exist. `afterCursor` returns only trades newer than a cursor the API handed out earlier (the dashboard uses this so each pull transfers just the new trades). `delayMs` overrides the configured delay for a single call, which is handy with curl:

```bash
curl "http://localhost:4001/getTrades?delayMs=0" | head -c 400
```

Other endpoints: `GET /config` (current settings) and `GET /health`.

## Configuration

Mock BSE API (`mock-bse/server.js`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4001` | Port to listen on |
| `PULL_DELAY_MS` | `900000` | How long `/getTrades` takes to answer (15 minutes) |
| `SEED_TRADES` | `3000` | Number of seeded historical trades |
| `GROWTH_INTERVAL_MS` | `20000` | A new trade appears this often |
| `SEED` | `20261108` | Seed for the generator |
| `STATE_FILE` | `mock-bse/state.json` | Remembers the start time so ids stay stable across restarts |

Dashboard (`dashboard/server.js`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `BSE_URL` | `http://localhost:4001` | Where the BSE API lives |
| `DATA_FILE` | `dashboard/data/trades.json` | Snapshot of pulled trades; lets a restart open instantly with data |
| `PULL_MIN_GAP_MS` | `1000` | Minimum time between two pulls, a safety net if the API is ever very fast |

## Dashboard API

`GET /api/trades?page=1&pageSize=50&q=reliance` returns a page of trades, newest first, optionally filtered by trade ID, client or symbol. It reads only from the local store and never waits on a pull. `GET /api/status` returns the current pull state and summary figures. `GET /api/events` is the Server-Sent Events stream the page listens to: a `status` event on connect and whenever the pull state changes, and a `trades` event when a pull completes with new trades.

## Tests

```bash
npm test
```

The end-to-end test starts both services with a short delay and checks the behaviour the brief asks for: the seeded data has the right shape and is deterministic, the configured delay is honoured, the dashboard page and trade list load in well under 300 ms while a pull is in flight and already contain the earlier pulled trades, a completed pull is pushed to an open event stream with no request from the client, and no trade is ever duplicated.

## Project layout

```
mock-bse/server.js        Mock BSE API (seeded data, configurable delay)
dashboard/server.js       HTTP API, SSE hub, static files
dashboard/lib/store.js    Trade store (memory + atomic JSON snapshot)
dashboard/lib/puller.js   Background pull loop
dashboard/public/         The dashboard UI (plain HTML, CSS, JS)
scripts/demo.js           Starts both services together
test/e2e.test.js          End-to-end test
ARCHITECTURE.md           Design note and diagram
docs/                     Diagram image and the video walkthrough script
```

## Troubleshooting

If the table is empty after opening the page, the very first pull has not completed yet: it takes as long as the mock delay (15 minutes by default, 20 seconds with `npm run demo`). The progress card shows how far along it is. After the first pull the data is saved to `dashboard/data/trades.json`, so later restarts show data immediately.

To start from scratch, stop both services and delete `dashboard/data/` and `mock-bse/state.json`.

If a port is busy, set `PORT` for the dashboard or `PORT` for the mock (and `BSE_URL` for the dashboard to match).
