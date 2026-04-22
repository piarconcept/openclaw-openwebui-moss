#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

import { buildAgentRegistry } from './agents/registry.js';
import { InboundAttachmentService } from './attachments/inbound.js';
import { cleanupStaleDirectories } from './attachments/cleanup.js';
import { OutboundAttachmentService } from './attachments/outbound.js';
import {
  loadPluginConfigFromFile,
  loadRuntimeSettings,
  PLUGIN_ID,
  prepareAttachmentDirectory,
} from './config.js';
import { OpenClawChatClient } from './api/openclaw-client.js';
import { WebUIClient } from './api/webui-client.js';
import { pluginManifest } from './manifest.js';
import { WebUISocketGateway } from './realtime/socket.js';
import { AgentRouter } from './routing/agent-routing.js';
import { SecureMessageRouter } from './routing/router.js';
import { BasicRateLimiter, LoopProtector } from './security/access-control.js';
import { createLogger } from './utils/logger.js';

export { pluginManifest };
export default pluginManifest;

export async function createService() {
  const runtime = loadRuntimeSettings(process.env);
  const logger = createLogger({
    level: runtime.logLevel,
    context: {
      service: PLUGIN_ID,
    },
  });

  const config = await loadPluginConfigFromFile(runtime.configPath);
  await prepareAttachmentDirectory(config);
  if (config.attachments.enabled) {
    await cleanupStaleDirectories(config.attachments.tempDir, runtime.staleAttachmentMaxAgeMs, logger);
  }

  const registry = buildAgentRegistry(config.agents);
  const webUIClient = new WebUIClient(config.baseUrl, config.token, logger);
  const openClawClient = new OpenClawChatClient(
    runtime.openClawApiUrl,
    runtime.openClawRequestTimeoutMs,
    logger,
  );

  const router = new SecureMessageRouter({
    config,
    logger,
    webUIClient,
    openClawClient,
    rateLimiter: new BasicRateLimiter(config.rateLimit),
    loopProtector: new LoopProtector(config.botUserId),
    agentRouter: new AgentRouter(registry),
    inboundAttachments: new InboundAttachmentService(webUIClient, config.attachments, logger),
    outboundAttachments: new OutboundAttachmentService(webUIClient, config.attachments, logger),
    registry,
  });

  const gateway = new WebUISocketGateway({
    baseUrl: config.baseUrl,
    token: config.token,
    allowedChannels: config.allowedChannels,
    botUserId: config.botUserId,
    logger,
    onEvent: async (event) => router.handleEvent(event),
  });

  return {
    config,
    runtime,
    logger,
    gateway,
    async start() {
      await gateway.start();
      logger.info('Service started', {
        allowedChannelCount: config.allowedChannels.length,
        allowedUserCount: config.allowedUsers.length,
        agentCount: registry.length,
      });
    },
    async stop() {
      await gateway.stop();
      logger.info('Service stopped');
    },
  };
}

async function main(): Promise<void> {
  const service = await createService();
  await service.start();

  const shutdown = async (signal: string) => {
    service.logger.info('Shutting down service', { signal });
    await service.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  void main().catch((error) => {
    const logger = createLogger({
      context: {
        service: PLUGIN_ID,
      },
    });
    logger.error('Fatal startup failure', { error });
    process.exitCode = 1;
  });
}
