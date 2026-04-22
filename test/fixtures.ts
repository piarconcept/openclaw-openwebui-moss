import type { PluginConfig } from '../src/types/config.js';

export function buildBaseConfig(): PluginConfig {
  return {
    baseUrl: 'https://openwebui.example.com',
    token: 'test-token',
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
