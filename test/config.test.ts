import { describe, expect, it } from 'vitest';

import {
  defaultConfig,
  isPluginConfigured,
  normalizePluginConfig,
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
