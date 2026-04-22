import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenClawChatClient } from '../src/api/openclaw-client.js';
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('openclaw chat client', () => {
  it('calls the OpenClaw OpenAI-compatible endpoint and extracts assistant content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Hello from OpenClaw.',
              },
              finish_reason: 'stop',
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    );

    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenClawChatClient(
      'http://127.0.0.1:18789/v1/chat/completions',
      'openai-codex/gpt-5.4',
      1000,
      createLogger(),
    );

    const response = await client.chat({
      agentId: 'main',
      message: 'Prompt body',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18789/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openai-codex/gpt-5.4',
          messages: [
            {
              role: 'user',
              content: 'Prompt body',
            },
          ],
        }),
      }),
    );
    expect(response.text).toBe('Hello from OpenClaw.');
    expect(response.attachments).toEqual([]);
  });

  it('passes through full message history when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'History preserved.',
              },
              finish_reason: 'stop',
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    );

    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenClawChatClient(
      'http://127.0.0.1:18789/v1/chat/completions',
      'openai-codex/gpt-5.4',
      1000,
      createLogger(),
    );

    const response = await client.chat({
      agentId: 'main',
      messages: [
        {
          role: 'system',
          content: 'You are Moss.',
        },
        {
          role: 'user',
          content: 'hello',
        },
        {
          role: 'assistant',
          content: 'hi',
        },
        {
          role: 'user',
          content: 'continue',
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18789/v1/chat/completions',
      expect.objectContaining({
        body: JSON.stringify({
          model: 'openai-codex/gpt-5.4',
          messages: [
            {
              role: 'system',
              content: 'You are Moss.',
            },
            {
              role: 'user',
              content: 'hello',
            },
            {
              role: 'assistant',
              content: 'hi',
            },
            {
              role: 'user',
              content: 'continue',
            },
          ],
        }),
      }),
    );
    expect(response.text).toBe('History preserved.');
  });
});
