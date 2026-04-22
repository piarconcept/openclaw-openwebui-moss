import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ModelWorkspaceRegistry } from '../src/provider/registry.js';
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

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('model workspace registry', () => {
  it('loads models from filesystem workspaces and skips folders without IDENTITY.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moss-models-'));
    tempDirectories.push(root);

    const devDir = join(root, 'moss-dev');
    await mkdir(join(devDir, 'docs'), { recursive: true });
    await writeFile(join(devDir, 'IDENTITY.md'), 'You are Moss Dev.', 'utf8');
    await writeFile(join(devDir, 'config.json'), JSON.stringify({ agentId: 'dev-agent' }), 'utf8');
    await writeFile(join(devDir, 'docs', 'coding-guidelines.md'), 'Always write tests.', 'utf8');

    const editorialDir = join(root, 'moss-editorial');
    await mkdir(editorialDir, { recursive: true });
    await writeFile(join(editorialDir, 'IDENTITY.md'), 'You are Moss Editorial.', 'utf8');
    await writeFile(join(editorialDir, 'style-guide.md'), 'Keep the tone concise.', 'utf8');

    const invalidDir = join(root, 'moss-invalid');
    await mkdir(invalidDir, { recursive: true });
    await writeFile(join(invalidDir, 'notes.md'), 'Missing identity file.', 'utf8');

    const registry = new ModelWorkspaceRegistry({
      modelsRootDir: root,
      logger: createLogger(),
    });

    const models = await registry.list();

    expect(models.map((model) => model.id)).toEqual(['moss-dev', 'moss-editorial']);
    expect(models[0]?.agentId).toBe('dev-agent');
    expect(models[0]?.context).toContain('File: docs/coding-guidelines.md');
    expect(models[1]?.agentId).toBe('main');
  });

  it('reloads filesystem changes without code changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moss-models-refresh-'));
    tempDirectories.push(root);

    const registry = new ModelWorkspaceRegistry({
      modelsRootDir: root,
      logger: createLogger(),
    });

    expect(await registry.list()).toEqual([]);

    const operatorDir = join(root, 'moss-operator');
    await mkdir(operatorDir, { recursive: true });
    await writeFile(join(operatorDir, 'IDENTITY.md'), 'You are Moss Operator.', 'utf8');
    await writeFile(join(operatorDir, 'runbook.txt'), 'Escalate safely.', 'utf8');

    const models = await registry.list();
    expect(models.map((model) => model.id)).toEqual(['moss-operator']);
    expect(models[0]?.context).toContain('Escalate safely.');
  });
});
