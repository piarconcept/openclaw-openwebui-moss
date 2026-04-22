import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenClawChatClient } from '../src/api/openclaw-client.js';
import type { IntegrationError } from '../src/utils/errors.js';
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
  it('sends a bearer token when the gateway token is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Authenticated.',
              },
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
      'gateway-token',
    );

    await client.chat({
      agentId: 'main',
      message: 'Prompt body',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18789/v1/chat/completions',
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer gateway-token',
          'x-openclaw-model': 'openai-codex/gpt-5.4',
        },
      }),
    );
  });

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
          'x-openclaw-model': 'openai-codex/gpt-5.4',
        },
        body: JSON.stringify({
          model: 'openclaw/main',
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
        headers: {
          'Content-Type': 'application/json',
          'x-openclaw-model': 'openai-codex/gpt-5.4',
        },
        body: JSON.stringify({
          model: 'openclaw/main',
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

  it('forwards session keys through the documented header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Session kept.',
              },
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

    await client.chat({
      agentId: 'main',
      sessionKey: 'session-123',
      message: 'Prompt body',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18789/v1/chat/completions',
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          'x-openclaw-model': 'openai-codex/gpt-5.4',
          'x-openclaw-session-key': 'session-123',
        },
      }),
    );
  });

  it('surfaces upstream HTTP details when OpenClaw rejects the request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      ),
    );

    const client = new OpenClawChatClient(
      'http://127.0.0.1:18789/v1/chat/completions',
      'openai-codex/gpt-5.4',
      1000,
      createLogger(),
    );

    await expect(
      client.chat({
        agentId: 'main',
        message: 'Prompt body',
      }),
    ).rejects.toMatchObject<Partial<IntegrationError>>({
      code: 'OPENCLAW_CHAT_FAILED',
      message:
        'OpenClaw /v1/chat/completions returned HTTP 401: {"error":{"message":"Unauthorized"}}',
    });
  });

  it('explains the likely OpenClaw config issue when the chat endpoint is disabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('Not Found', {
          status: 404,
          headers: {
            'Content-Type': 'text/plain',
          },
        }),
      ),
    );

    const client = new OpenClawChatClient(
      'http://127.0.0.1:18789/v1/chat/completions',
      'openai-codex/gpt-5.4',
      1000,
      createLogger(),
    );

    await expect(
      client.chat({
        agentId: 'main',
        message: 'Prompt body',
      }),
    ).rejects.toMatchObject<Partial<IntegrationError>>({
      code: 'OPENCLAW_CHAT_FAILED',
      message:
        'OpenClaw /v1/chat/completions returned HTTP 404: Not Found. The Gateway OpenAI-compatible chat endpoint is likely disabled; enable gateway.http.endpoints.chatCompletions.enabled in openclaw.json',
    });
  });
});
