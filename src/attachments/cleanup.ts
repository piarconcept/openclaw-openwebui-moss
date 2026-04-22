import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { Logger } from '../utils/logger.js';

export function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 80);
  return sanitized || 'item';
}

export async function createRequestTempDir(baseDir: string, correlationId: string): Promise<string> {
  await mkdir(baseDir, { recursive: true });
  return mkdtemp(join(baseDir || tmpdir(), `${sanitizePathSegment(correlationId)}-`));
}

export async function cleanupPath(pathValue: string | undefined): Promise<void> {
  if (!pathValue) {
    return;
  }

  await rm(pathValue, { recursive: true, force: true });
}

export async function cleanupStaleDirectories(
  baseDir: string,
  maxAgeMs: number,
  logger?: Logger,
): Promise<void> {
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const fullPath = join(baseDir, entry.name);
      const fileStats = await stat(fullPath);
      if (now - fileStats.mtimeMs > maxAgeMs) {
        await rm(fullPath, { recursive: true, force: true });
        logger?.info('Removed stale attachment directory', { path: fullPath });
      }
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }
}
