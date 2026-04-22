import type {
  PasswordAuthConfig,
  PluginConfig,
  TokenAuthConfig,
} from '../src/types/config.js';

export function buildTokenAuth(): TokenAuthConfig {
  return {
    mode: 'token',
    token: 'test-token',
  };
}

export function buildPasswordAuth(): PasswordAuthConfig {
  return {
    mode: 'password',
    email: 'bot@example.com',
    password: 'super-secret-password',
  };
}

export function buildBaseConfig(): PluginConfig {
  return {
    baseUrl: 'https://openwebui.example.com',
    auth: buildTokenAuth(),
    botUserId: 'bot-user-id',
    requireMention: true,
    allowedChannels: ['channel-editorial', 'channel-dev'],
    allowedUsers: ['user-1', 'user-2'],
    agents: {
      editorial: {
        channelId: 'channel-editorial',
        trigger: '@moss-editorial',
        agentId: 'moss-editorial',
      },
      dev: {
        channelId: 'channel-dev',
        trigger: '@moss-dev',
        agentId: 'moss-dev',
      },
      client: {
        trigger: '@moss-client',
        agentId: 'moss-client',
      },
    },
    attachments: {
      enabled: true,
      maxBytes: 1024 * 1024,
      tempDir: '/tmp/openclaw-openwebui-moss-test',
    },
    rateLimit: {
      enabled: true,
      windowMs: 1000,
      maxMessages: 2,
    },
  };
}

export function buildPasswordConfig(): PluginConfig {
  return {
    ...buildBaseConfig(),
    auth: buildPasswordAuth(),
  };
}
