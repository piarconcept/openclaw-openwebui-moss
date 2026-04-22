import { PLUGIN_ID, PLUGIN_VERSION, pluginConfigSchema } from './config.js';

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  runtime: {
    node: string;
  };
  channels: string[];
  entrypoint: string;
  configSchema: typeof pluginConfigSchema;
}

export const pluginManifest: PluginManifest = {
  id: PLUGIN_ID,
  name: 'OpenClaw Open WebUI Moss',
  description: 'Secure OpenClaw plugin for Open WebUI channels with Moss multi-agent routing.',
  version: PLUGIN_VERSION,
  runtime: {
    node: '>=22.0.0',
  },
  channels: ['open-webui'],
  entrypoint: 'dist/index.js',
  configSchema: pluginConfigSchema,
};
