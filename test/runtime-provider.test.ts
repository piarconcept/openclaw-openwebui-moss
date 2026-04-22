import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { closeProviderServerMock, startProviderServerMock } = vi.hoisted(() => ({
  closeProviderServerMock: vi.fn(async () => {}),
  startProviderServerMock: vi.fn(async () => ({
    server: {} as never,
    close: closeProviderServerMock,
  })),
}));

vi.mock('../src/provider/server.js', () => ({
  startProviderServer: startProviderServerMock,
}));

import { createService } from '../src/runtime/start.js';
import type { Logger } from '../src/utils/logger.js';

function createLogger(): Logger {
  const logger: Logger = {
    child: () => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  return logger;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  startProviderServerMock.mockClear();
  closeProviderServerMock.mockClear();
});

describe('runtime provider exposure', () => {
  it('starts the provider server even when plugin config is missing', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'moss-provider-runtime-'));
    const missingConfigPath = join(tempDir, 'missing-plugin.config.json');

    vi.stubEnv('OPENWEBUI_MOSS_CONFIG_PATH', missingConfigPath);
    vi.stubEnv('OPENCLAW_API_URL', 'http://127.0.0.1:18789/api/chat');
    vi.stubEnv('MOSS_PROVIDER_HOST', '127.0.0.1');
    vi.stubEnv('MOSS_PROVIDER_PORT', '18790');
    vi.stubEnv('MOSS_MODELS_DIR', join(tempDir, 'moss-models'));

    const service = await createService({ logger: createLogger() });

    try {
      const result = await service.start();
      expect(result).toEqual({
        active: false,
        reason: 'disabled-unconfigured',
      });

      expect(startProviderServerMock).toHaveBeenCalledTimes(1);
      const options = startProviderServerMock.mock.calls[0]?.[0];
      expect(options.host).toBe('127.0.0.1');
      expect(options.port).toBe(18790);
      expect(options.modelsRootDir).toBe(join(tempDir, 'moss-models'));
      expect(options.getExecutionStatus?.()).toEqual({
        enabled: false,
        status: 503,
        code: 'plugin_not_configured',
        message: 'Plugin not configured',
      });
    } finally {
      await service.stop();
      expect(closeProviderServerMock).toHaveBeenCalledTimes(1);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
