export interface AgentRouteConfig {
  agentId: string;
  channelId?: string;
  trigger?: string;
}

export interface AgentRouteConfigInput {
  agentId?: string;
  channelId?: string;
  trigger?: string;
}

export interface TokenAuthConfig {
  mode: 'token';
  token: string;
}

export interface PasswordAuthConfig {
  mode: 'password';
  email: string;
  password: string;
}

export interface UnconfiguredAuthConfig {
  mode: '';
}

export type PluginAuthConfig = TokenAuthConfig | PasswordAuthConfig | UnconfiguredAuthConfig;
export type RuntimeAuthConfig = TokenAuthConfig | PasswordAuthConfig;

export interface PluginAuthConfigInput {
  mode?: string;
  token?: string;
  email?: string;
  password?: string;
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
  auth: PluginAuthConfig;
  botUserId: string;
  requireMention: boolean;
  allowedChannels: string[];
  allowedUsers: string[];
  agents: Record<string, AgentRouteConfig>;
  attachments: AttachmentsConfig;
  rateLimit: RateLimitConfig;
}

export interface PluginConfigInput {
  baseUrl?: string;
  auth?: PluginAuthConfigInput;
  botUserId?: string;
  requireMention?: boolean;
  allowedChannels?: string[];
  allowedUsers?: string[];
  agents?: Record<string, AgentRouteConfigInput>;
  attachments?: Partial<AttachmentsConfig>;
  rateLimit?: Partial<RateLimitConfig>;
}

export interface LoadedPluginConfig {
  config: PluginConfig;
  loadIssues: string[];
}

export interface RuntimeSettings {
  configPath: string;
  openClawApiUrl: string;
  openClawModel: string;
  openClawRequestTimeoutMs: number;
  staleAttachmentMaxAgeMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export type ValidatedPluginConfig = Omit<PluginConfig, 'auth'> & {
  auth: RuntimeAuthConfig;
};
