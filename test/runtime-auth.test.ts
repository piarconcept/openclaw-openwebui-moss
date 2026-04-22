import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
});

describe('runtime auth handling', () => {
  it('disables the plugin safely when bot authentication fails', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'moss-auth-failure-'));
    const configPath = join(tempDir, 'plugin.config.json');
    await writeFile(configPath, JSON.stringify(buildPasswordConfig()), 'utf8');

    vi.stubEnv('OPENWEBUI_MOSS_CONFIG_PATH', configPath);
    vi.stubEnv('OPENCLAW_API_URL', 'http://127.0.0.1:3000/api/chat');
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

      expect(result.active).toBe(false);
      expect(result.reason).toBe('disabled-auth-failed');
      expect(
        entries.some(
          (entry) =>
            entry.level === 'warn' && entry.message.includes('authentication failed; plugin remains disabled'),
        ),
      ).toBe(true);
    } finally {
      await service.stop();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
