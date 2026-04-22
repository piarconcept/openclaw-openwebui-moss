import { describe, expect, it } from 'vitest';

import { buildAgentRegistry } from '../src/agents/registry.js';
import { evaluateMentionPolicy } from '../src/security/mention-policy.js';
import { buildBaseConfig } from './fixtures.js';

const registry = buildAgentRegistry(buildBaseConfig().agents);

describe('mention policy', () => {
  it('accepts native bot mentions', () => {
    const result = evaluateMentionPolicy({
      text: '<@U:bot-user-id|Moss> please respond',
      botUserId: 'bot-user-id',
      requireMention: true,
      registry,
    });

    expect(result.accepted).toBe(true);
    expect(result.botMentioned).toBe(true);
  });

  it('accepts a valid agent trigger', () => {
    const result = evaluateMentionPolicy({
      text: '@moss-dev check this issue',
      botUserId: 'bot-user-id',
      requireMention: true,
      registry,
    });

    expect(result.accepted).toBe(true);
    expect(result.matchedTriggers).toHaveLength(1);
    expect(result.matchedTriggers[0]?.agentId).toBe('moss-dev');
  });

  it('rejects messages without mention or trigger when mention gating is on', () => {
    const result = evaluateMentionPolicy({
      text: 'hello team',
      botUserId: 'bot-user-id',
      requireMention: true,
      registry,
    });

    expect(result.accepted).toBe(false);
  });

  it('rejects messages with multiple triggers', () => {
    const result = evaluateMentionPolicy({
      text: '@moss-dev and @moss-client please both review',
      botUserId: 'bot-user-id',
      requireMention: true,
      registry,
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/multiple/i);
  });
});
