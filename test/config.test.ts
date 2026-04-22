import { describe, expect, it } from 'vitest';

import { validatePluginConfig } from '../src/config.js';
import { ConfigError } from '../src/utils/errors.js';
import { buildBaseConfig } from './fixtures.js';

describe('validatePluginConfig', () => {
  it('accepts a valid config and normalizes baseUrl', () => {
    const config = buildBaseConfig();
    config.baseUrl = 'https://openwebui.example.com/';

    const validated = validatePluginConfig(config);

    expect(validated.baseUrl).toBe('https://openwebui.example.com');
    expect(validated.botUserId).toBe('bot-user-id');
  });

  it('rejects unknown root properties', () => {
    const config = {
      ...buildBaseConfig(),
      unexpected: true,
    };

    expect(() => validatePluginConfig(config)).toThrowError(ConfigError);
  });

  it('rejects duplicate triggers', () => {
    const config = buildBaseConfig();
    config.agents.dev.trigger = '@moss-editorial';

    expect(() => validatePluginConfig(config)).toThrowError(ConfigError);
  });

  it('rejects duplicate channel mappings', () => {
    const config = buildBaseConfig();
    config.agents.dev.channelId = 'channel-editorial';

    expect(() => validatePluginConfig(config)).toThrowError(ConfigError);
  });
});
