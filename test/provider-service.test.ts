import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelWorkspaceRegistry } from '../src/provider/registry.js';
import { MossOpenAIProviderService } from '../src/provider/service.js';
import type { OpenClawChatResponse } from '../src/types/messages.js';
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

describe('moss openai provider service', () => {
  it('lists filesystem models and sends model identity plus full chat history to OpenClaw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moss-provider-'));
    tempDirectories.push(root);

    const modelDir = join(root, 'moss-dev');
    await mkdir(join(modelDir, 'docs'), { recursive: true });
    await writeFile(join(modelDir, 'IDENTITY.md'), 'You are Moss Dev.', 'utf8');
    await writeFile(join(modelDir, 'config.json'), JSON.stringify({ agentId: 'dev-agent' }), 'utf8');
    await writeFile(join(modelDir, 'docs', 'architecture.md'), 'Use layered services.', 'utf8');

    const registry = new ModelWorkspaceRegistry({
      modelsRootDir: root,
      logger: createLogger(),
    });
    const chat = vi.fn<
      (request: { agentId: string; message: string }) => Promise<OpenClawChatResponse>
    >().mockResolvedValue({
      text: 'Done.',
      attachments: [],
      raw: {},
    });

    const service = new MossOpenAIProviderService(
      registry,
      { chat } as { chat: typeof chat },
      createLogger(),
    );

    const models = await service.listModels();
    expect(models.data).toEqual([
      {
        id: 'moss-dev',
        object: 'model',
      },
    ]);

    const completion = await service.createChatCompletion({
      model: 'moss-dev',
      messages: [
        {
          role: 'assistant',
          content: 'Old answer',
        },
        {
          role: 'user',
          content: 'Refactor this safely.',
        },
      ],
    });

    expect(chat).toHaveBeenCalledTimes(1);
    const request = chat.mock.calls[0]?.[0];
    expect(request).toEqual({
      agentId: 'dev-agent',
      messages: [
        {
          role: 'system',
          content: 'You are Moss Dev.\n\nContext:\nFile: docs/architecture.md\nUse layered services.',
        },
        {
          role: 'assistant',
          content: 'Old answer',
        },
        {
          role: 'user',
          content: 'Refactor this safely.',
        },
      ],
    });
    expect(completion.choices[0]?.message.content).toBe('Done.');
    expect(completion.model).toBe('moss-dev');
  });

  it('defaults to agentId main when model config is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moss-provider-disabled-'));
    tempDirectories.push(root);

    const modelDir = join(root, 'moss-dev');
    await mkdir(modelDir, { recursive: true });
    await writeFile(join(modelDir, 'IDENTITY.md'), 'You are Moss Dev.', 'utf8');

    const registry = new ModelWorkspaceRegistry({
      modelsRootDir: root,
      logger: createLogger(),
    });
    const chat = vi.fn<
      (request: { agentId: string; message: string }) => Promise<OpenClawChatResponse>
    >().mockResolvedValue({
      text: 'Done.',
      attachments: [],
      raw: {},
    });

    const service = new MossOpenAIProviderService(
      registry,
      { chat } as { chat: typeof chat },
      createLogger(),
    );

    const completion = await service.createChatCompletion({
      model: 'moss-dev',
      messages: [
        {
          role: 'system',
          content: 'Stay concise.',
        },
        {
          role: 'user',
          content: 'Can you help?',
        },
      ],
    });

    expect(chat).toHaveBeenCalledWith({
      agentId: 'main',
      messages: [
        {
          role: 'system',
          content: 'You are Moss Dev.',
        },
        {
          role: 'system',
          content: 'Stay concise.',
        },
        {
          role: 'user',
          content: 'Can you help?',
        },
      ],
    });
    expect(completion.choices[0]?.message.content).toBe('Done.');
  });
});
