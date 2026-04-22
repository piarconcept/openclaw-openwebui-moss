import type { RegisteredAgent } from '../agents/registry.js';
import type {
  AgentResolution,
  MentionPolicyDecision,
  NormalizedInboundMessage,
} from '../types/messages.js';
import { RoutingError } from '../utils/errors.js';

interface BoundAgent {
  agentKey: string;
  agentId: string;
}

function deriveBindingKey(message: NormalizedInboundMessage): string {
  if (message.channelType === 'dm') {
    return `dm:${message.channelId}`;
  }

  if (message.parentId) {
    return `channel:${message.channelId}:thread:${message.parentId}`;
  }

  return `channel:${message.channelId}`;
}

export class AgentRouter {
  private readonly bindings = new Map<string, BoundAgent>();

  public constructor(private readonly registry: readonly RegisteredAgent[]) {}

  public resolve(
    message: NormalizedInboundMessage,
    mentionDecision: MentionPolicyDecision,
  ): AgentResolution {
    const bindingKey = deriveBindingKey(message);
    const bound = this.bindings.get(bindingKey);
    if (bound) {
      return {
        ...bound,
        bindingKey,
        sessionKey: this.sessionKey(bindingKey, bound.agentId),
        source: 'binding',
      };
    }

    if (mentionDecision.matchedTriggers.length > 1) {
      throw new RoutingError('AGENT_AMBIGUOUS', 'Multiple agent triggers matched this message', {
        triggers: mentionDecision.matchedTriggers.map((entry) => entry.trigger),
      });
    }

    const triggerMatch = mentionDecision.matchedTriggers[0];
    if (triggerMatch) {
      const resolved: BoundAgent = {
        agentKey: triggerMatch.agentKey,
        agentId: triggerMatch.agentId,
      };
      this.bindings.set(bindingKey, resolved);
      return {
        ...resolved,
        bindingKey,
        sessionKey: this.sessionKey(bindingKey, resolved.agentId),
        source: 'trigger',
      };
    }

    const channelMatches = this.registry.filter((agent) => agent.channelId === message.channelId);
    if (channelMatches.length > 1) {
      throw new RoutingError('AGENT_AMBIGUOUS', 'Multiple channel mappings matched this message', {
        channelId: message.channelId,
        agents: channelMatches.map((entry) => entry.agentId),
      });
    }

    const channelMatch = channelMatches[0];
    if (channelMatch) {
      const resolved: BoundAgent = {
        agentKey: channelMatch.key,
        agentId: channelMatch.agentId,
      };
      this.bindings.set(bindingKey, resolved);
      return {
        ...resolved,
        bindingKey,
        sessionKey: this.sessionKey(bindingKey, resolved.agentId),
        source: 'channel',
      };
    }

    throw new RoutingError('AGENT_UNRESOLVED', 'Unable to resolve exactly one agent for message', {
      channelId: message.channelId,
      matchedTriggers: mentionDecision.matchedTriggers.map((entry) => entry.trigger),
    });
  }

  private sessionKey(bindingKey: string, agentId: string): string {
    return `owui:${bindingKey}:agent:${agentId}`;
  }
}
