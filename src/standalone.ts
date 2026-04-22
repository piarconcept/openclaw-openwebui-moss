import { startPlugin, stopPlugin } from './runtime/start.js';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

let shuttingDown = false;
const keepAlive = setInterval(() => {
  // Keep the standalone runtime alive until an explicit shutdown signal arrives.
}, 60_000);

async function shutdown(signal: ShutdownSignal): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearInterval(keepAlive);

  try {
    console.log(`[moss] received ${signal}, stopping standalone runtime`);
    await stopPlugin();
    process.exitCode = 0;
  } catch (error) {
    console.error('[moss] standalone shutdown failed', error);
    process.exitCode = 1;
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

void (async () => {
  try {
    await startPlugin();
  } catch (error) {
    clearInterval(keepAlive);
    console.error('[moss] standalone startup failed', error);
    process.exitCode = 1;
  }
})();
