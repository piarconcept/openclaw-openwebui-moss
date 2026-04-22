import { access, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import type {
  AgentRouteConfig,
  PluginConfig,
  RuntimeSettings,
  ValidatedPluginConfig,
} from './types/config.js';
import { ConfigError } from './utils/errors.js';

export const PLUGIN_ID = 'openclaw-openwebui-moss';
export const PLUGIN_VERSION = '0.1.0';
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const ROOT_KEYS = [
  'baseUrl',
  'token',
  'botUserId',
  'requireMention',
  'allowedChannels',
  'allowedUsers',
  'agents',
  'attachments',
  'rateLimit',
] as const;
const ATTACHMENT_KEYS = ['enabled', 'maxBytes', 'tempDir'] as const;
const RATE_LIMIT_KEYS = ['enabled', 'windowMs', 'maxMessages'] as const;
const AGENT_KEYS = ['agentId', 'channelId', 'trigger'] as const;
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

export const pluginConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: ROOT_KEYS,
  properties: {
    baseUrl: { type: 'string', format: 'uri' },
    token: { type: 'string', minLength: 1 },
    botUserId: { type: 'string', minLength: 1 },
    requireMention: { type: 'boolean' },
    allowedChannels: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    allowedUsers: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    agents: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['agentId'],
        properties: {
          agentId: { type: 'string', minLength: 1 },
          channelId: { type: 'string', minLength: 1 },
          trigger: { type: 'string', minLength: 1 },
        },
      },
    },
    attachments: {
      type: 'object',
      additionalProperties: false,
      required: ATTACHMENT_KEYS,
      properties: {
        enabled: { type: 'boolean' },
        maxBytes: { type: 'integer', minimum: 1 },
        tempDir: { type: 'string', minLength: 1 },
      },
    },
    rateLimit: {
      type: 'object',
      additionalProperties: false,
      required: RATE_LIMIT_KEYS,
      properties: {
        enabled: { type: 'boolean' },
        windowMs: { type: 'integer', minimum: 1000 },
        maxMessages: { type: 'integer', minimum: 1 },
      },
    },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
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

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): string | undefined {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(`${path}.${key} must be a non-empty string`);
    return undefined;
  }

  return value.trim();
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(`${path}.${key} must be a non-empty string when provided`);
    return undefined;
  }

  return value.trim();
}

function readRequiredBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): boolean | undefined {
  const value = record[key];
  if (typeof value !== 'boolean') {
    issues.push(`${path}.${key} must be a boolean`);
    return undefined;
  }

  return value;
}

function readRequiredInteger(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
  minimum = 1,
): number | undefined {
  const value = record[key];
  if (!Number.isInteger(value) || typeof value !== 'number' || value < minimum) {
    issues.push(`${path}.${key} must be an integer >= ${minimum}`);
    return undefined;
  }

  return value;
}

function readUniqueStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${path}.${key} must be a non-empty array of strings`);
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      issues.push(`${path}.${key} entries must be non-empty strings`);
      continue;
    }

    const trimmed = entry.trim();
    if (seen.has(trimmed)) {
      issues.push(`${path}.${key} contains a duplicate entry: ${trimmed}`);
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function normalizeBaseUrl(value: string, issues: string[]): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      issues.push('config.baseUrl must use http or https');
      return value;
    }

    url.search = '';
    url.hash = '';
    const pathname = url.pathname.replace(/\/+$/u, '');
    return `${url.origin}${pathname}`;
  } catch {
    issues.push('config.baseUrl must be a valid URL');
    return value;
  }
}

function validateAgents(
  value: unknown,
  allowedChannels: string[],
  issues: string[],
): Record<string, AgentRouteConfig> {
  if (!isRecord(value)) {
    issues.push('config.agents must be an object');
    return {};
  }

  const allowedChannelSet = new Set(allowedChannels);
  const validatedAgents: Record<string, AgentRouteConfig> = {};
  const seenTriggers = new Map<string, string>();
  const seenChannelMappings = new Map<string, string>();

  for (const [agentKey, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      issues.push(`config.agents.${agentKey} must be an object`);
      continue;
    }

    rejectUnknownKeys(entry, AGENT_KEYS, `config.agents.${agentKey}`, issues);
    const agentId = readRequiredString(entry, 'agentId', `config.agents.${agentKey}`, issues);
    const channelId = readOptionalString(entry, 'channelId', `config.agents.${agentKey}`, issues);
    const trigger = readOptionalString(entry, 'trigger', `config.agents.${agentKey}`, issues);

    if (!channelId && !trigger) {
      issues.push(`config.agents.${agentKey} must define channelId or trigger`);
      continue;
    }

    if (channelId && !allowedChannelSet.has(channelId)) {
      issues.push(
        `config.agents.${agentKey}.channelId must also appear in allowedChannels: ${channelId}`,
      );
    }

    if (trigger && /\s/iu.test(trigger)) {
      issues.push(`config.agents.${agentKey}.trigger must be a single token without spaces`);
    }

    if (trigger) {
      const existing = seenTriggers.get(trigger);
      if (existing) {
        issues.push(
          `config.agents.${agentKey}.trigger duplicates trigger ${trigger} already used by ${existing}`,
        );
      } else {
        seenTriggers.set(trigger, agentKey);
      }
    }

    if (channelId) {
      const existing = seenChannelMappings.get(channelId);
      if (existing) {
        issues.push(
          `config.agents.${agentKey}.channelId duplicates channel ${channelId} already mapped by ${existing}`,
        );
      } else {
        seenChannelMappings.set(channelId, agentKey);
      }
    }

    if (agentId) {
      validatedAgents[agentKey] = {
        agentId,
        ...(channelId ? { channelId } : {}),
        ...(trigger ? { trigger } : {}),
      };
    }
  }

  if (Object.keys(validatedAgents).length === 0) {
    issues.push('config.agents must contain at least one valid agent mapping');
  }

  return validatedAgents;
}

export function validatePluginConfig(input: unknown): ValidatedPluginConfig {
  const issues: string[] = [];

  if (!isRecord(input)) {
    throw new ConfigError(['config must be an object']);
  }

  rejectUnknownKeys(input, ROOT_KEYS, 'config', issues);

  const baseUrl = normalizeBaseUrl(
    readRequiredString(input, 'baseUrl', 'config', issues) ?? '',
    issues,
  );
  const token = readRequiredString(input, 'token', 'config', issues) ?? '';
  const botUserId = readRequiredString(input, 'botUserId', 'config', issues) ?? '';
  const requireMention = readRequiredBoolean(input, 'requireMention', 'config', issues) ?? true;
  const allowedChannels = readUniqueStringArray(input, 'allowedChannels', 'config', issues);
  const allowedUsers = readUniqueStringArray(input, 'allowedUsers', 'config', issues);
  const agents = validateAgents(input.agents, allowedChannels, issues);

  const attachmentsValue = input.attachments;
  if (!isRecord(attachmentsValue)) {
    issues.push('config.attachments must be an object');
  }

  const attachmentsRecord = isRecord(attachmentsValue) ? attachmentsValue : {};
  rejectUnknownKeys(attachmentsRecord, ATTACHMENT_KEYS, 'config.attachments', issues);
  const attachmentsEnabled =
    readRequiredBoolean(attachmentsRecord, 'enabled', 'config.attachments', issues) ?? false;
  const attachmentsMaxBytes =
    readRequiredInteger(attachmentsRecord, 'maxBytes', 'config.attachments', issues, 1) ?? 1;
  const attachmentsTempDir =
    readRequiredString(attachmentsRecord, 'tempDir', 'config.attachments', issues) ?? '';

  if (attachmentsMaxBytes > MAX_ATTACHMENT_BYTES) {
    issues.push(`config.attachments.maxBytes must be <= ${MAX_ATTACHMENT_BYTES}`);
  }

  if (attachmentsTempDir && !isAbsolute(attachmentsTempDir)) {
    issues.push('config.attachments.tempDir must be an absolute path');
  }

  const rateLimitValue = input.rateLimit;
  if (!isRecord(rateLimitValue)) {
    issues.push('config.rateLimit must be an object');
  }

  const rateLimitRecord = isRecord(rateLimitValue) ? rateLimitValue : {};
  rejectUnknownKeys(rateLimitRecord, RATE_LIMIT_KEYS, 'config.rateLimit', issues);
  const rateLimitEnabled =
    readRequiredBoolean(rateLimitRecord, 'enabled', 'config.rateLimit', issues) ?? true;
  const rateLimitWindowMs =
    readRequiredInteger(rateLimitRecord, 'windowMs', 'config.rateLimit', issues, 1000) ?? 30000;
  const rateLimitMaxMessages =
    readRequiredInteger(rateLimitRecord, 'maxMessages', 'config.rateLimit', issues, 1) ?? 1;

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  const validated: PluginConfig = {
    baseUrl,
    token,
    botUserId,
    requireMention,
    allowedChannels,
    allowedUsers,
    agents,
    attachments: {
      enabled: attachmentsEnabled,
      maxBytes: attachmentsMaxBytes,
      tempDir: attachmentsTempDir,
    },
    rateLimit: {
      enabled: rateLimitEnabled,
      windowMs: rateLimitWindowMs,
      maxMessages: rateLimitMaxMessages,
    },
  };

  return validated;
}

export async function loadPluginConfigFromFile(filePath: string): Promise<ValidatedPluginConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new ConfigError([
      `Unable to read plugin config at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError([
      `Plugin config at ${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  return validatePluginConfig(parsed);
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

  const attachmentDir = config.attachments.tempDir;
  await mkdir(attachmentDir, { recursive: true });
  await mkdir(dirname(attachmentDir), { recursive: true });
  await access(attachmentDir);
}
