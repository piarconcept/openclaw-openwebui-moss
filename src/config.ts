import { access, mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type {
  AgentRouteConfig,
  AgentRouteConfigInput,
  LoadedPluginConfig,
  PluginAuthConfig,
  PluginConfig,
  PluginConfigInput,
  RuntimeSettings,
  ValidatedPluginConfig,
} from './types/config.js';
import { ConfigError } from './utils/errors.js';

export const PLUGIN_ID = 'openclaw-openwebui-moss';
export const PLUGIN_VERSION = '0.1.0';
export const DEFAULT_ATTACHMENT_TEMP_DIR = '/tmp/openclaw-openwebui-moss';
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const ROOT_KEYS = [
  'baseUrl',
  'auth',
  'botUserId',
  'requireMention',
  'allowedChannels',
  'allowedUsers',
  'agents',
  'attachments',
  'rateLimit',
] as const;
const AUTH_KEYS = ['mode', 'token', 'email', 'password'] as const;
const ATTACHMENT_KEYS = ['enabled', 'maxBytes', 'tempDir'] as const;
const RATE_LIMIT_KEYS = ['enabled', 'windowMs', 'maxMessages'] as const;
const AGENT_KEYS = ['agentId', 'channelId', 'trigger'] as const;
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

export const pluginConfigSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    baseUrl: { type: 'string' },
    auth: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['token', 'password'],
        },
        token: { type: 'string' },
        email: { type: 'string' },
        password: { type: 'string' },
      },
    },
    botUserId: { type: 'string' },
    requireMention: { type: 'boolean' },
    allowedChannels: {
      type: 'array',
      items: { type: 'string' },
    },
    allowedUsers: {
      type: 'array',
      items: { type: 'string' },
    },
    agents: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agentId: { type: 'string' },
          channelId: { type: 'string' },
          trigger: { type: 'string' },
        },
      },
    },
    attachments: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        maxBytes: { type: 'integer', minimum: 1 },
        tempDir: { type: 'string' },
      },
    },
    rateLimit: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        windowMs: { type: 'integer', minimum: 1000 },
        maxMessages: { type: 'integer', minimum: 1 },
      },
    },
  },
} as const;

export const defaultConfig: PluginConfig = {
  baseUrl: '',
  auth: {
    mode: '',
  },
  botUserId: '',
  requireMention: true,
  allowedChannels: [],
  allowedUsers: [],
  agents: {},
  attachments: {
    enabled: false,
    maxBytes: 10 * 1024 * 1024,
    tempDir: DEFAULT_ATTACHMENT_TEMP_DIR,
  },
  rateLimit: {
    enabled: true,
    windowMs: 30000,
    maxMessages: 12,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneDefaultConfig(): PluginConfig {
  return {
    ...defaultConfig,
    auth: { ...defaultConfig.auth },
    allowedChannels: [...defaultConfig.allowedChannels],
    allowedUsers: [...defaultConfig.allowedUsers],
    agents: { ...defaultConfig.agents },
    attachments: { ...defaultConfig.attachments },
    rateLimit: { ...defaultConfig.rateLimit },
  };
}

function collectUnknownKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
  issues: string[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      issues.push(`${path}.${key} is not allowed`);
    }
  }
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
  options?: { trim?: boolean },
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    issues.push(`${path}.${key} must be a string when provided`);
    return undefined;
  }

  return options?.trim === false ? value : value.trim();
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    issues.push(`${path}.${key} must be a boolean when provided`);
    return undefined;
  }

  return value;
}

function readOptionalInteger(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    issues.push(`${path}.${key} must be an integer when provided`);
    return undefined;
  }

  return value;
}

function readOptionalUniqueStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    issues.push(`${path}.${key} must be an array of strings when provided`);
    return undefined;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== 'string') {
      issues.push(`${path}.${key} entries must be strings`);
      continue;
    }

    const trimmed = entry.trim();
    if (trimmed === '') {
      issues.push(`${path}.${key} entries must not be empty`);
      continue;
    }

    if (seen.has(trimmed)) {
      issues.push(`${path}.${key} contains a duplicate entry: ${trimmed}`);
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function normalizeBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    const pathname = url.pathname.replace(/\/+$/u, '');
    return `${url.origin}${pathname}`;
  } catch {
    return value;
  }
}

function normalizeAuth(value: unknown, issues: string[]): PluginAuthConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    issues.push('config.auth must be an object when provided');
    return undefined;
  }

  collectUnknownKeys(value, AUTH_KEYS, 'config.auth', issues);
  const mode = readOptionalString(value, 'mode', 'config.auth', issues);
  const token = readOptionalString(value, 'token', 'config.auth', issues);
  const email = readOptionalString(value, 'email', 'config.auth', issues);
  const password = readOptionalString(value, 'password', 'config.auth', issues, { trim: false });

  if (!mode) {
    if (token !== undefined || email !== undefined || password !== undefined) {
      issues.push('config.auth.mode is required when auth credentials are provided');
    }
    return { mode: '' };
  }

  if (mode === 'token') {
    if (email !== undefined) {
      issues.push('config.auth.email is not allowed when auth.mode is token');
    }
    if (password !== undefined) {
      issues.push('config.auth.password is not allowed when auth.mode is token');
    }

    return {
      mode: 'token',
      token: token ?? '',
    };
  }

  if (mode === 'password') {
    if (token !== undefined) {
      issues.push('config.auth.token is not allowed when auth.mode is password');
    }

    return {
      mode: 'password',
      email: email ?? '',
      password: password ?? '',
    };
  }

  issues.push('config.auth.mode must be "token" or "password" when provided');
  return { mode: '' };
}

function normalizeAgents(
  value: unknown,
  issues: string[],
): Record<string, AgentRouteConfig> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    issues.push('config.agents must be an object when provided');
    return undefined;
  }

  const normalized: Record<string, AgentRouteConfig> = {};

  for (const [agentKey, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      issues.push(`config.agents.${agentKey} must be an object`);
      continue;
    }

    collectUnknownKeys(entry, AGENT_KEYS, `config.agents.${agentKey}`, issues);
    const rawAgent = entry as AgentRouteConfigInput;
    normalized[agentKey] = {
      agentId: typeof rawAgent.agentId === 'string' ? rawAgent.agentId.trim() : '',
      ...(typeof rawAgent.channelId === 'string' && rawAgent.channelId.trim() !== ''
        ? { channelId: rawAgent.channelId.trim() }
        : {}),
      ...(typeof rawAgent.trigger === 'string' && rawAgent.trigger.trim() !== ''
        ? { trigger: rawAgent.trigger.trim() }
        : {}),
    };
  }

  return normalized;
}

export function normalizePluginConfig(input: unknown): LoadedPluginConfig {
  const config = cloneDefaultConfig();
  const loadIssues: string[] = [];

  if (input === undefined || input === null) {
    return { config, loadIssues };
  }

  if (!isRecord(input)) {
    return {
      config,
      loadIssues: ['config must be an object'],
    };
  }

  collectUnknownKeys(input, ROOT_KEYS, 'config', loadIssues);

  const baseUrl = readOptionalString(input, 'baseUrl', 'config', loadIssues);
  if (baseUrl !== undefined) {
    config.baseUrl = normalizeBaseUrl(baseUrl);
  }

  const auth = normalizeAuth(input.auth, loadIssues);
  if (auth !== undefined) {
    config.auth = auth;
  }

  const botUserId = readOptionalString(input, 'botUserId', 'config', loadIssues);
  if (botUserId !== undefined) {
    config.botUserId = botUserId;
  }

  const requireMention = readOptionalBoolean(input, 'requireMention', 'config', loadIssues);
  if (requireMention !== undefined) {
    config.requireMention = requireMention;
  }

  const allowedChannels = readOptionalUniqueStringArray(input, 'allowedChannels', 'config', loadIssues);
  if (allowedChannels !== undefined) {
    config.allowedChannels = allowedChannels;
  }

  const allowedUsers = readOptionalUniqueStringArray(input, 'allowedUsers', 'config', loadIssues);
  if (allowedUsers !== undefined) {
    config.allowedUsers = allowedUsers;
  }

  const agents = normalizeAgents(input.agents, loadIssues);
  if (agents !== undefined) {
    config.agents = agents;
  }

  const attachmentsValue = input.attachments;
  if (attachmentsValue !== undefined) {
    if (!isRecord(attachmentsValue)) {
      loadIssues.push('config.attachments must be an object when provided');
    } else {
      collectUnknownKeys(attachmentsValue, ATTACHMENT_KEYS, 'config.attachments', loadIssues);
      const enabled = readOptionalBoolean(attachmentsValue, 'enabled', 'config.attachments', loadIssues);
      const maxBytes = readOptionalInteger(attachmentsValue, 'maxBytes', 'config.attachments', loadIssues);
      const tempDir = readOptionalString(attachmentsValue, 'tempDir', 'config.attachments', loadIssues);
      if (enabled !== undefined) {
        config.attachments.enabled = enabled;
      }
      if (maxBytes !== undefined) {
        config.attachments.maxBytes = maxBytes;
      }
      if (tempDir !== undefined && tempDir !== '') {
        config.attachments.tempDir = tempDir;
      }
    }
  }

  const rateLimitValue = input.rateLimit;
  if (rateLimitValue !== undefined) {
    if (!isRecord(rateLimitValue)) {
      loadIssues.push('config.rateLimit must be an object when provided');
    } else {
      collectUnknownKeys(rateLimitValue, RATE_LIMIT_KEYS, 'config.rateLimit', loadIssues);
      const enabled = readOptionalBoolean(rateLimitValue, 'enabled', 'config.rateLimit', loadIssues);
      const windowMs = readOptionalInteger(rateLimitValue, 'windowMs', 'config.rateLimit', loadIssues);
      const maxMessages = readOptionalInteger(rateLimitValue, 'maxMessages', 'config.rateLimit', loadIssues);
      if (enabled !== undefined) {
        config.rateLimit.enabled = enabled;
      }
      if (windowMs !== undefined) {
        config.rateLimit.windowMs = windowMs;
      }
      if (maxMessages !== undefined) {
        config.rateLimit.maxMessages = maxMessages;
      }
    }
  }

  return {
    config,
    loadIssues,
  };
}

function validateRequiredAgentMappings(
  agents: Record<string, AgentRouteConfig>,
  allowedChannels: readonly string[],
  issues: string[],
): void {
  const entries = Object.entries(agents);
  if (entries.length === 0) {
    issues.push('config.agents must contain at least one agent mapping');
    return;
  }

  const allowedChannelSet = new Set(allowedChannels);
  const seenTriggers = new Map<string, string>();
  const seenChannelMappings = new Map<string, string>();

  for (const [agentKey, agent] of entries) {
    if (!agent.agentId || agent.agentId.trim() === '') {
      issues.push(`config.agents.${agentKey}.agentId is required`);
    }

    if (!agent.channelId && !agent.trigger) {
      issues.push(`config.agents.${agentKey} must define channelId or trigger`);
    }

    if (agent.channelId) {
      if (!allowedChannelSet.has(agent.channelId)) {
        issues.push(
          `config.agents.${agentKey}.channelId must also appear in allowedChannels: ${agent.channelId}`,
        );
      }
      const existing = seenChannelMappings.get(agent.channelId);
      if (existing) {
        issues.push(
          `config.agents.${agentKey}.channelId duplicates channel ${agent.channelId} already mapped by ${existing}`,
        );
      } else {
        seenChannelMappings.set(agent.channelId, agentKey);
      }
    }

    if (agent.trigger) {
      if (/\s/iu.test(agent.trigger)) {
        issues.push(`config.agents.${agentKey}.trigger must be a single token without spaces`);
      }
      const existing = seenTriggers.get(agent.trigger);
      if (existing) {
        issues.push(
          `config.agents.${agentKey}.trigger duplicates trigger ${agent.trigger} already used by ${existing}`,
        );
      } else {
        seenTriggers.set(agent.trigger, agentKey);
      }
    }
  }
}

function validateAuthConfig(auth: PluginAuthConfig, issues: string[]): void {
  if (auth.mode === '') {
    issues.push('config.auth is required');
    return;
  }

  if (auth.mode === 'token') {
    if (!auth.token) {
      issues.push('config.auth.token is required when auth.mode is token');
    }
    return;
  }

  if (!auth.email) {
    issues.push('config.auth.email is required when auth.mode is password');
  }

  if (!auth.password) {
    issues.push('config.auth.password is required when auth.mode is password');
  }
}

export function validateRuntimeConfig(config: PluginConfig): string[] {
  const issues: string[] = [];

  if (!config.baseUrl) {
    issues.push('config.baseUrl is required');
  } else {
    try {
      const parsed = new URL(config.baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        issues.push('config.baseUrl must use http or https');
      }
    } catch {
      issues.push('config.baseUrl must be a valid URL');
    }
  }

  validateAuthConfig(config.auth, issues);

  if (!config.botUserId) {
    issues.push('config.botUserId is required');
  }

  if (config.allowedChannels.length === 0) {
    issues.push('config.allowedChannels must contain at least one channel');
  }

  if (config.allowedUsers.length === 0) {
    issues.push('config.allowedUsers must contain at least one user');
  }

  validateRequiredAgentMappings(config.agents, config.allowedChannels, issues);

  if (!Number.isInteger(config.rateLimit.windowMs) || config.rateLimit.windowMs < 1000) {
    issues.push('config.rateLimit.windowMs must be an integer >= 1000');
  }

  if (!Number.isInteger(config.rateLimit.maxMessages) || config.rateLimit.maxMessages < 1) {
    issues.push('config.rateLimit.maxMessages must be an integer >= 1');
  }

  if (!Number.isInteger(config.attachments.maxBytes) || config.attachments.maxBytes < 1) {
    issues.push('config.attachments.maxBytes must be an integer >= 1');
  } else if (config.attachments.maxBytes > MAX_ATTACHMENT_BYTES) {
    issues.push(`config.attachments.maxBytes must be <= ${MAX_ATTACHMENT_BYTES}`);
  }

  if (config.attachments.enabled) {
    if (!config.attachments.tempDir) {
      issues.push('config.attachments.tempDir is required when attachments are enabled');
    } else if (!isAbsolute(config.attachments.tempDir)) {
      issues.push('config.attachments.tempDir must be an absolute path');
    }
  }

  return issues;
}

export function isPluginConfigured(config: PluginConfig): boolean {
  return Boolean(
    config.baseUrl ||
      config.auth.mode ||
      config.botUserId ||
      config.requireMention !== defaultConfig.requireMention ||
      config.allowedChannels.length > 0 ||
      config.allowedUsers.length > 0 ||
      Object.keys(config.agents).length > 0 ||
      config.attachments.enabled !== defaultConfig.attachments.enabled ||
      config.attachments.maxBytes !== defaultConfig.attachments.maxBytes ||
      config.attachments.tempDir !== defaultConfig.attachments.tempDir ||
      config.rateLimit.enabled !== defaultConfig.rateLimit.enabled ||
      config.rateLimit.windowMs !== defaultConfig.rateLimit.windowMs ||
      config.rateLimit.maxMessages !== defaultConfig.rateLimit.maxMessages
  );
}

export async function loadPluginConfigFromFile(filePath: string): Promise<LoadedPluginConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return normalizePluginConfig(undefined);
    }

    return {
      ...normalizePluginConfig(undefined),
      loadIssues: [
        `Unable to read plugin config at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as PluginConfigInput;
  } catch (error) {
    return {
      ...normalizePluginConfig(undefined),
      loadIssues: [
        `Plugin config at ${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  return normalizePluginConfig(parsed);
}

function readPositiveIntegerEnv(name: string, value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError([`${name} must be a positive integer when provided`]);
  }

  return parsed;
}

function validateAbsoluteUrl(name: string, value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('must use http or https');
    }

    return parsed.toString();
  } catch (error) {
    throw new ConfigError([
      `${name} must be a valid absolute URL: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

export function loadRuntimeSettings(env: Record<string, string | undefined> = process.env): RuntimeSettings {
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!LOG_LEVELS.has(logLevel)) {
    throw new ConfigError([`LOG_LEVEL must be one of: ${Array.from(LOG_LEVELS).join(', ')}`]);
  }

  return {
    configPath: env.OPENWEBUI_MOSS_CONFIG_PATH ?? join(process.cwd(), 'config', 'plugin.config.json'),
    openClawApiUrl: validateAbsoluteUrl(
      'OPENCLAW_API_URL',
      env.OPENCLAW_API_URL ?? 'http://127.0.0.1:3000/api/chat',
    ),
    openClawRequestTimeoutMs: readPositiveIntegerEnv(
      'OPENCLAW_REQUEST_TIMEOUT_MS',
      env.OPENCLAW_REQUEST_TIMEOUT_MS,
      60000,
    ),
    staleAttachmentMaxAgeMs: readPositiveIntegerEnv(
      'ATTACHMENT_STALE_TTL_MS',
      env.ATTACHMENT_STALE_TTL_MS,
      24 * 60 * 60 * 1000,
    ),
    logLevel,
  } as RuntimeSettings;
}

export async function prepareAttachmentDirectory(config: ValidatedPluginConfig): Promise<void> {
  if (!config.attachments.enabled) {
    return;
  }

  await mkdir(config.attachments.tempDir, { recursive: true });
  await access(config.attachments.tempDir);
}
