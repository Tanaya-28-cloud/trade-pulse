'use strict';
/**
 * Starts the mock BSE API and the dashboard together.
 *
 *   npm run demo    -> 20 s pull delay (good for trying it out and for the video)
 *   npm start       -> the real 15 minute pull delay
 *
 * Extra: DELAY_MS=45000 npm run demo   (any delay you like)
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const realDelay = process.argv.includes('--real-delay');
const delayMs = process.env.DELAY_MS ? Number(process.env.DELAY_MS) : realDelay ? 15 * 60 * 1000 : 20000;

const children = [
  spawn(process.execPath, [path.join(root, 'mock-bse', 'server.js')], {
    stdio: 'inherit',
    env: { ...process.env, PULL_DELAY_MS: String(delayMs) },
  }),
  spawn(process.execPath, [path.join(root, 'dashboard', 'server.js')], {
    stdio: 'inherit',
    env: process.env,
  }),
];

console.log(`\n  Mock BSE   http://localhost:${process.env.MOCK_PORT || 4001}/getTrades   (pull delay ${delayMs / 1000}s)`);
console.log(`  Dashboard  http://localhost:${process.env.PORT || 3000}\n`);

function stop() {
  for (const c of children) c.kill('SIGTERM');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', () => { stop(); process.exit(0); });
