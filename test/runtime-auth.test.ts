import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { buildPasswordConfig } from './fixtures.js';

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}

function createSpyLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger: Logger = {
    child: () => logger,
    debug: (message, meta) => {
      entries.push({ level: 'debug', message, ...(meta ? { meta } : {}) });
    },
    info: (message, meta) => {
      entries.push({ level: 'info', message, ...(meta ? { meta } : {}) });
    },
    warn: (message, meta) => {
      entries.push({ level: 'warn', message, ...(meta ? { meta } : {}) });
    },
    error: (message, meta) => {
      entries.push({ level: 'error', message, ...(meta ? { meta } : {}) });
    },
  };

  return { logger, entries };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  startProviderServerMock.mockClear();
  closeProviderServerMock.mockClear();
});

describe('runtime auth handling', () => {
  it('disables the plugin safely when bot authentication fails without disabling the provider server', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'moss-auth-failure-'));
    const configPath = join(tempDir, 'plugin.config.json');
    await writeFile(configPath, JSON.stringify(buildPasswordConfig()), 'utf8');

    vi.stubEnv('OPENWEBUI_MOSS_CONFIG_PATH', configPath);
    vi.stubEnv('OPENCLAW_API_URL', 'http://127.0.0.1:18789/api/chat');
    vi.stubEnv('MOSS_PROVIDER_HOST', '127.0.0.1');
    vi.stubEnv('MOSS_PROVIDER_PORT', '18790');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'The email or password provided is incorrect.' }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      ),
    );

    const { logger, entries } = createSpyLogger();
    const service = await createService({ logger });

    try {
      const result = await service.start();

      expect(result.active).toBe(true);
      expect(result.reason).toBe('started');
      expect(startProviderServerMock).toHaveBeenCalledTimes(1);
      expect(
        entries.some(
          (entry) =>
            entry.level === 'warn' && entry.message.includes('authentication failed; plugin remains disabled'),
        ),
      ).toBe(true);
      expect(
        entries.some(
          (entry) =>
            entry.level === 'warn' &&
            entry.message === 'Moss plugin running in fallback mode' &&
            entry.meta?.reason === 'auth-failed',
        ),
      ).toBe(true);
    } finally {
      await service.stop();
      expect(closeProviderServerMock).toHaveBeenCalledTimes(1);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
