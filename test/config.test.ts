import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  defaultConfig,
  isPluginConfigured,
  normalizePluginConfig,
  resolveOpenClawGatewayToken,
  validateRuntimeConfig,
} from '../src/config.js';
import { buildBaseConfig, buildPasswordConfig } from './fixtures.js';

describe('normalizePluginConfig', () => {
  it('accepts a valid token-auth config and normalizes baseUrl', () => {
    const config = buildBaseConfig();
    config.baseUrl = 'https://openwebui.example.com/';

    const loaded = normalizePluginConfig(config);

    expect(loaded.loadIssues).toEqual([]);
    expect(loaded.config.baseUrl).toBe('https://openwebui.example.com');
    expect(loaded.config.botUserId).toBe('bot-user-id');
    expect(loaded.config.auth).toEqual({
      mode: 'token',
      token: 'test-token',
    });
  });

  it('accepts a valid password-auth config', () => {
    const loaded = normalizePluginConfig(buildPasswordConfig());

    expect(loaded.loadIssues).toEqual([]);
    expect(loaded.config.auth).toEqual({
      mode: 'password',
      email: 'bot@example.com',
      password: 'super-secret-password',
    });
  });

  it('returns safe defaults for missing config without throwing', () => {
    const loaded = normalizePluginConfig(undefined);

    expect(loaded.loadIssues).toEqual([]);
    expect(loaded.config).toEqual(defaultConfig);
    expect(isPluginConfigured(loaded.config)).toBe(false);
  });

  it('captures unknown root properties as load issues without throwing', () => {
    const loaded = normalizePluginConfig({
      ...buildBaseConfig(),
      unexpected: true,
    });

    expect(loaded.loadIssues.some((issue) => issue.includes('config.unexpected'))).toBe(true);
  });

  it('captures invalid auth field combinations as load issues', () => {
    const loaded = normalizePluginConfig({
      ...buildBaseConfig(),
      auth: {
        mode: 'token',
        token: 'test-token',
        email: 'bot@example.com',
      },
    });

    expect(loaded.loadIssues).toContain('config.auth.email is not allowed when auth.mode is token');
  });
});

describe('validateRuntimeConfig', () => {
  it('accepts a complete token-auth runtime config', () => {
    expect(validateRuntimeConfig(buildBaseConfig())).toEqual([]);
  });

  it('accepts a complete password-auth runtime config', () => {
    expect(validateRuntimeConfig(buildPasswordConfig())).toEqual([]);
  });

  it('accepts wildcard allowedChannels and allowedUsers', () => {
    const config = buildBaseConfig();
    config.allowedChannels = ['*'];
    config.allowedUsers = ['*'];

    expect(validateRuntimeConfig(config)).toEqual([]);
  });

  it('rejects duplicate triggers at runtime', () => {
    const config = buildBaseConfig();
    config.agents.dev.trigger = '@moss-editorial';

    expect(validateRuntimeConfig(config).some((issue) => issue.includes('duplicates trigger'))).toBe(
      true,
    );
  });

  it('rejects duplicate channel mappings at runtime', () => {
    const config = buildBaseConfig();
    config.agents.dev.channelId = 'channel-editorial';

    expect(
      validateRuntimeConfig(config).some((issue) => issue.includes('duplicates channel')),
    ).toBe(true);
  });

  it('allows agent channel mappings outside the explicit list when wildcard channel access is enabled', () => {
    const config = buildBaseConfig();
    config.allowedChannels = ['*'];
    config.agents.dev.channelId = 'channel-anything';

    expect(validateRuntimeConfig(config)).toEqual([]);
  });

  it('fails closed when baseUrl or auth are missing', () => {
    const config = buildBaseConfig();
    config.baseUrl = '';
    config.auth = { mode: '' };

    const issues = validateRuntimeConfig(config);
    expect(issues).toContain('config.baseUrl is required');
    expect(issues).toContain('config.auth is required');
  });

  it('requires a password when auth.mode is password', () => {
    const config = buildPasswordConfig();
    config.auth.password = '';

    const issues = validateRuntimeConfig(config);
    expect(issues).toContain('config.auth.password is required when auth.mode is password');
  });
});

describe('resolveOpenClawGatewayToken', () => {
  it('prefers OPENCLAW_GATEWAY_TOKEN when provided', async () => {
    await expect(
      resolveOpenClawGatewayToken({
        OPENCLAW_GATEWAY_TOKEN: 'env-token',
      }),
    ).resolves.toBe('env-token');
  });

  it('reads the gateway token from openclaw.json when env is absent', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'moss-openclaw-config-'));
    const configPath = join(tempDir, 'openclaw.json');

    try {
      await writeFile(
        configPath,
        JSON.stringify({
          gateway: {
            auth: {
              mode: 'token',
              token: 'config-token',
            },
          },
        }),
        'utf8',
      );

      await expect(
        resolveOpenClawGatewayToken({
          OPENCLAW_CONFIG_PATH: configPath,
        }),
      ).resolves.toBe('config-token');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
