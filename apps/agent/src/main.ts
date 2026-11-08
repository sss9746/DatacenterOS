// Entry point for `pnpm --filter agent start`. Wiring (db-client, physics, NIM) lands in P3-1..P3-8.
import { ConfigError, loadConfig, redact } from './config.js';

function main(): void {
  try {
    const cfg = loadConfig();
    console.log('agent: config', redact(cfg));
    console.log('agent: not wired yet');
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`agent: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

main();
