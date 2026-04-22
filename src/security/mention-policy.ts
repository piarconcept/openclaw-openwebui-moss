import type { RegisteredAgent } from '../agents/registry.js';
import type { MentionPolicyDecision, TriggerMatch } from '../types/messages.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function createTriggerPattern(trigger: string): RegExp {
  return new RegExp(
    `(^|[\\s([<{])${escapeRegExp(trigger)}(?=$|[\\s)\\]}>.,!?;:])`,
    'u',
  );
}

export function hasBotMention(text: string, botUserId: string): boolean {
  const pattern = new RegExp(`<@U:${escapeRegExp(botUserId)}(?:\\|[^>]+)?>`, 'u');
  return pattern.test(text);
}

export function evaluateMentionPolicy(options: {
  text: string;
  botUserId: string;
  requireMention: boolean;
  registry: readonly RegisteredAgent[];
}): MentionPolicyDecision {
  const { text, botUserId, requireMention, registry } = options;
  const botMentioned = hasBotMention(text, botUserId);

  const matchedTriggers: TriggerMatch[] = registry
    .filter((agent) => agent.trigger)
    .filter((agent) => createTriggerPattern(agent.trigger as string).test(text))
    .map((agent) => ({
      agentKey: agent.key,
      agentId: agent.agentId,
      trigger: agent.trigger as string,
    }));

  if (requireMention) {
    if (matchedTriggers.length > 1) {
      return {
        accepted: false,
        botMentioned,
        matchedTriggers,
        reason: 'multiple agent triggers matched',
      };
    }

    if (!botMentioned && matchedTriggers.length === 0) {
      return {
        accepted: false,
        botMentioned,
        matchedTriggers,
        reason: 'message is missing bot mention or agent trigger',
      };
    }
  }

  return {
    accepted: true,
    botMentioned,
    matchedTriggers,
  };
}
