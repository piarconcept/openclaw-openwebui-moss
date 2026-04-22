import { join } from 'node:path';
import { homedir } from 'node:os';

import { loadRuntimeSettings } from './config.js';
import { startProviderServer } from './provider/server.js';
import { createLogger } from './utils/logger.js';

function parsePort(value: string | undefined): number {
  if (!value) {
    return 4000;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('MOSS_PROVIDER_PORT must be an integer between 1 and 65535');
  }

  return parsed;
}

const runtime = loadRuntimeSettings(process.env);
const host = process.env.MOSS_PROVIDER_HOST ?? process.env.HOST ?? '127.0.0.1';
const port = parsePort(process.env.MOSS_PROVIDER_PORT ?? process.env.PORT);
const modelsRootDir =
  process.env.MOSS_MODELS_DIR ?? join(homedir(), '.openclaw', 'workspace', 'moss-models');
const logger = createLogger({
  level: runtime.logLevel,
  context: {
    service: 'openclaw-openwebui-moss-provider',
  },
});

let handle: Awaited<ReturnType<typeof startProviderServer>> | null = null;

async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  logger.info('Shutting down Moss provider server', {
    signal,
  });
  if (!handle) {
    process.exitCode = 0;
    return;
  }

  try {
    await handle.close();
    process.exitCode = 0;
  } catch (error) {
    logger.error('Failed to shut down Moss provider server cleanly', {
      error,
    });
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
    handle = await startProviderServer({
      host,
      port,
      modelsRootDir,
      openClawApiUrl: runtime.openClawApiUrl,
      openClawModel: runtime.openClawModel,
      openClawTimeoutMs: runtime.openClawRequestTimeoutMs,
      logger,
    });
  } catch (error) {
    logger.error('Failed to start Moss provider server', {
      error,
    });
    process.exitCode = 1;
  }
})();
