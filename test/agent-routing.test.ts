import { describe, expect, it } from 'vitest';

import { buildAgentRegistry } from '../src/agents/registry.js';
import { AgentRouter } from '../src/routing/agent-routing.js';
import type { MentionPolicyDecision, NormalizedInboundMessage } from '../src/types/messages.js';
import { RoutingError } from '../src/utils/errors.js';
import { buildBaseConfig } from './fixtures.js';

const registry = buildAgentRegistry(buildBaseConfig().agents);

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

function noMention(): MentionPolicyDecision {
  return {
    accepted: true,
    botMentioned: true,
    matchedTriggers: [],
  };
}

describe('agent routing', () => {
  it('binds a thread and keeps routing to the same agent', () => {
    const router = new AgentRouter(registry);

    const first = router.resolve(
      buildMessage({ parentId: 'thread-1', channelId: 'channel-editorial' }),
      noMention(),
    );
    const second = router.resolve(
      buildMessage({
        id: 'message-2',
        parentId: 'thread-1',
        channelId: 'channel-editorial',
      }),
      {
        accepted: true,
        botMentioned: false,
        matchedTriggers: [
          {
            agentKey: 'dev',
            agentId: 'moss-dev',
            trigger: '@moss-dev',
          },
        ],
      },
    );

    expect(first.agentId).toBe('moss-editorial');
    expect(second.agentId).toBe('moss-editorial');
    expect(second.source).toBe('binding');
  });

  it('uses an explicit trigger before channel mapping on a new thread', () => {
    const router = new AgentRouter(registry);

    const result = router.resolve(buildMessage(), {
      accepted: true,
      botMentioned: false,
      matchedTriggers: [
        {
          agentKey: 'dev',
          agentId: 'moss-dev',
          trigger: '@moss-dev',
        },
      ],
    });

    expect(result.agentId).toBe('moss-dev');
    expect(result.source).toBe('trigger');
  });

  it('rejects unroutable messages', () => {
    const router = new AgentRouter(registry);

    expect(() =>
      router.resolve(
        buildMessage({
          channelId: 'channel-unknown',
          rawEvent: {
            channel_id: 'channel-unknown',
            message_id: 'message-1',
            data: {
              type: 'message',
              data: {
                id: 'message-1',
                channel_id: 'channel-unknown',
                user_id: 'user-1',
                content: 'hello',
              },
            },
          },
        }),
        noMention(),
      ),
    ).toThrowError(RoutingError);
  });

  it('rejects ambiguous trigger matches', () => {
    const router = new AgentRouter(registry);

    expect(() =>
      router.resolve(buildMessage(), {
        accepted: true,
        botMentioned: false,
        matchedTriggers: [
          {
            agentKey: 'dev',
            agentId: 'moss-dev',
            trigger: '@moss-dev',
          },
          {
            agentKey: 'client',
            agentId: 'moss-client',
            trigger: '@moss-client',
          },
        ],
      }),
    ).toThrowError(RoutingError);
  });
});
