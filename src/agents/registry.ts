import type { AgentRouteConfig } from '../types/config.js';

export interface RegisteredAgent extends AgentRouteConfig {
  key: string;
}

export function buildAgentRegistry(
  agents: Record<string, AgentRouteConfig>,
): readonly RegisteredAgent[] {
  return Object.entries(agents).map(([key, value]) => ({
    key,
    agentId: value.agentId,
    ...(value.channelId ? { channelId: value.channelId } : {}),
    ...(value.trigger ? { trigger: value.trigger } : {}),
  }));
}
