
'use strict';

/**
 * Starts the mock BSE API and dashboard together.
 *
 * npm run demo -> 20-second pull delay
 * npm start     -> real 15-minute pull delay
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const realDelay = process.argv.includes('--real-delay');

const delayMs = process.env.DELAY_MS
  ? Number(process.env.DELAY_MS)
  : realDelay
    ? 15 * 60 * 1000
    : 20000;

const mockPort = Number(process.env.MOCK_PORT || 4001);
const dashboardPort = Number(process.env.PORT || 3000);

const children = [
  spawn(process.execPath, [path.join(root, 'mock-bse', 'server.js')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(mockPort),
      PULL_DELAY_MS: String(delayMs),
    },
  }),

  spawn(process.execPath, [path.join(root, 'dashboard', 'server.js')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(dashboardPort),
      BSE_URL: process.env.BSE_URL || `http://127.0.0.1:${mockPort}`,
    },
  }),
];

console.log(`\nMock BSE:  http://127.0.0.1:${mockPort}/getTrades`);
console.log(`Dashboard: http://localhost:${dashboardPort}`);
console.log(`Pull delay: ${delayMs / 1000} seconds\n`);

function stop() {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

for (const child of children) {
  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`A service exited with code ${code}`);
    }
    stop();
    process.exit(code || 0);
  });
}
