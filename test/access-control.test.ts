import { describe, expect, it } from 'vitest';

import {
  assertAllowedChannel,
  assertAllowedUser,
  BasicRateLimiter,
  LoopProtector,
} from '../src/security/access-control.js';
import type { NormalizedInboundMessage } from '../src/types/messages.js';
import type { RateLimitConfig } from '../src/types/config.js';
import { AuthorizationError, RateLimitError } from '../src/utils/errors.js';

function buildMessage(overrides?: Partial<NormalizedInboundMessage>): NormalizedInboundMessage {
  return {
    id: 'message-1',
    channelId: 'channel-editorial',
    channelType: 'channel',
    senderId: 'user-1',
    senderName: 'User One',
    text: 'hello',
    createdAt: Date.now(),
    meta: {},
    attachments: [],
    rawEvent: {
      channel_id: 'channel-editorial',
      message_id: 'message-1',
      data: {
        type: 'message',
        data: {
          id: 'message-1',
          channel_id: 'channel-editorial',
          user_id: 'user-1',
          content: 'hello',
        },
      },
    },
    ...overrides,
  };
}

describe('access control', () => {
  it('allows configured channels and users', () => {
    expect(() => assertAllowedChannel('channel-editorial', ['channel-editorial'])).not.toThrow();
    expect(() => assertAllowedUser('user-1', ['user-1'])).not.toThrow();
  });

  it('allows any channel and user when wildcard entries are configured', () => {
    expect(() => assertAllowedChannel('channel-anything', ['*'])).not.toThrow();
    expect(() => assertAllowedUser('user-anything', ['*'])).not.toThrow();
  });

  it('rejects unknown channels and users', () => {
    expect(() => assertAllowedChannel('channel-x', ['channel-editorial'])).toThrowError(
      AuthorizationError,
    );
    expect(() => assertAllowedUser('user-x', ['user-1'])).toThrowError(AuthorizationError);
  });
});

describe('basic rate limiter', () => {
  it('blocks after maxMessages inside the same window', () => {
    const config: RateLimitConfig = {
      enabled: true,
      windowMs: 1000,
      maxMessages: 2,
    };
    const limiter = new BasicRateLimiter(config);

    expect(limiter.consume('user-1', 'channel-editorial', 0).allowed).toBe(true);
    expect(limiter.consume('user-1', 'channel-editorial', 10).allowed).toBe(true);
    expect(() => limiter.consume('user-1', 'channel-editorial', 20)).toThrowError(
      RateLimitError,
    );
  });
});

describe('loop protection', () => {
  it('drops messages from the configured bot user', () => {
    const protector = new LoopProtector('bot-user-id');
    const result = protector.inspect(
      buildMessage({
        senderId: 'bot-user-id',
      }),
    );

    expect(result.loopDetected).toBe(true);
  });

  it('drops messages tagged as plugin outbound', () => {
    const protector = new LoopProtector('bot-user-id');
    const result = protector.inspect(
      buildMessage({
        meta: {
          source: 'openclaw-openwebui-moss',
        },
      }),
    );

    expect(result.loopDetected).toBe(true);
  });

  it('drops messages already seen in outbound cache', () => {
    const protector = new LoopProtector('bot-user-id');
    protector.rememberOutboundMessage('message-1', 100);

    const result = protector.inspect(buildMessage(), 200);
    expect(result.loopDetected).toBe(true);
  });
});
