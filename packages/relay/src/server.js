#!/usr/bin/env node
/**
 * CLI entry point: `node server.js` or `npm run relay` from the repo root.
 * Reads `relay.config.json` from the current working directory if present
 * (see relay.config.example.json at the repo root for the shape), otherwise
 * boots with defaults.
 */
import { readFile } from 'node:fs/promises';
import { QuRelay } from './relay.js';

async function loadConfig() {
  try {
    return JSON.parse(await readFile('./relay.config.json', 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

const config = await loadConfig();
const relay = await new QuRelay(config).boot();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n[QuRelay] received ${signal}, shutting down...`);
    await relay.close();
    process.exit(0);
  });
}
