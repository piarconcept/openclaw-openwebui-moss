import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebUIAuthSession } from '../src/api/webui-auth.js';
import { WebUIClient } from '../src/api/webui-client.js';
import type { Logger } from '../src/utils/logger.js';
import { buildPasswordAuth } from './fixtures.js';

function createTestLogger(): Logger {
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

describe('webui auth', () => {
  it('authenticates successfully with password mode and caches the token in memory', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: 'session-token-1' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const session = createWebUIAuthSession({
      baseUrl: 'https://openwebui.example.com',
      auth: buildPasswordAuth(),
      logger: createTestLogger(),
    });

    await expect(session.getToken()).resolves.toBe('session-token-1');
    await expect(session.getToken()).resolves.toBe('session-token-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-authenticates once on REST 401 and retries the request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'session-token-1' }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      )
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'session-token-2' }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'reply-1', content: 'ok' }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const session = createWebUIAuthSession({
      baseUrl: 'https://openwebui.example.com',
      auth: buildPasswordAuth(),
      logger: createTestLogger(),
    });
    const client = new WebUIClient('https://openwebui.example.com', session, createTestLogger());

    const message = await client.postMessage({
      channelId: 'channel-editorial',
      content: 'hello',
    });

    expect(message.id).toBe('reply-1');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Authorization: 'Bearer session-token-1',
      },
    });
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      headers: {
        Authorization: 'Bearer session-token-2',
      },
    });
  });
});
