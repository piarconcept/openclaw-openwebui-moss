export interface AgentRouteConfig {
  agentId: string;
  channelId?: string;
  trigger?: string;
}

export interface AttachmentsConfig {
  enabled: boolean;
  maxBytes: number;
  tempDir: string;
}

export interface RateLimitConfig {
  enabled: boolean;
  windowMs: number;
  maxMessages: number;
}

export interface PluginConfig {
  baseUrl: string;
  token: string;
  botUserId: string;
  requireMention: boolean;
  allowedChannels: string[];
  allowedUsers: string[];
  agents: Record<string, AgentRouteConfig>;
  attachments: AttachmentsConfig;
  rateLimit: RateLimitConfig;
}

export interface RuntimeSettings {
  configPath: string;
  openClawApiUrl: string;
  openClawRequestTimeoutMs: number;
  staleAttachmentMaxAgeMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export type ValidatedPluginConfig = PluginConfig;
