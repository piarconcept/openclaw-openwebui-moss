import { homedir } from 'node:os';
import { join } from 'node:path';

import { OpenClawChatClient } from '../api/openclaw-client.js';
import { createWebUIAuthSession } from '../api/webui-auth.js';
import { WebUIClient } from '../api/webui-client.js';
import { buildAgentRegistry } from '../agents/registry.js';
import { cleanupStaleDirectories } from '../attachments/cleanup.js';
import { InboundAttachmentService } from '../attachments/inbound.js';
import { OutboundAttachmentService } from '../attachments/outbound.js';
import {
  isPluginConfigured,
  loadPluginConfigFromFile,
  loadRuntimeSettings,
  PLUGIN_ID,
  prepareAttachmentDirectory,
  validateRuntimeConfig,
} from '../config.js';
import { startProviderServer } from '../provider/server.js';
import { WebUISocketGateway } from '../realtime/socket.js';
import { AgentRouter } from '../routing/agent-routing.js';
import { SecureMessageRouter } from '../routing/router.js';
import { BasicRateLimiter, LoopProtector } from '../security/access-control.js';
import type { ValidatedPluginConfig } from '../types/config.js';
import { AuthenticationError } from '../utils/errors.js';
import { createLogger, type LogMeta, type Logger } from '../utils/logger.js';

interface HostLoggerLike {
  debug?: (message: string, meta?: unknown) => void;
  info?: (message: string, meta?: unknown) => void;
  warn?: (message: string, meta?: unknown) => void;
  error?: (message: string, meta?: unknown) => void;
}

export interface ActivationContext {
  logger?: HostLoggerLike;
  [key: string]: unknown;
}

interface CreateServiceOptions {
  logger?: Logger;
}

export interface ServiceStartResult {
  active: boolean;
  reason:
    | 'started'
    | 'disabled-unconfigured'
    | 'disabled-invalid-config'
    | 'disabled-auth-failed';
}

export interface ServiceInstance {
  logger: Logger;
  start(): Promise<ServiceStartResult>;
  stop(): Promise<void>;
}

const DEFAULT_EMBEDDED_PROVIDER_HOST = '127.0.0.1';
const DEFAULT_EMBEDDED_PROVIDER_PORT = 18790;

interface EmbeddedProviderSettings {
  host: string;
  port: number;
  modelsRootDir: string;
}

function parseEmbeddedProviderPort(value: string | undefined): number {
  if (!value) {
    return DEFAULT_EMBEDDED_PROVIDER_PORT;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error('MOSS_PROVIDER_PORT must be an integer between 0 and 65535');
  }

  return parsed;
}

function loadEmbeddedProviderSettings(
  env: Record<string, string | undefined> = process.env,
): EmbeddedProviderSettings {
  return {
    host: env.MOSS_PROVIDER_HOST ?? env.HOST ?? DEFAULT_EMBEDDED_PROVIDER_HOST,
    port: parseEmbeddedProviderPort(env.MOSS_PROVIDER_PORT ?? env.PORT),
    modelsRootDir:
      env.MOSS_MODELS_DIR ?? join(homedir(), '.openclaw', 'workspace', 'moss-models'),
  };
}

class HostLoggerAdapter implements Logger {
  public constructor(
    private readonly hostLogger: HostLoggerLike | undefined,
    private readonly fallback: Logger,
    private readonly context: LogMeta,
  ) {}

  public child(context: LogMeta): Logger {
    return new HostLoggerAdapter(this.hostLogger, this.fallback.child(context), {
      ...this.context,
      ...context,
    });
  }

  public debug(message: string, meta?: LogMeta): void {
    this.emit('debug', message, meta);
  }

  public info(message: string, meta?: LogMeta): void {
    this.emit('info', message, meta);
  }

  public warn(message: string, meta?: LogMeta): void {
    this.emit('warn', message, meta);
  }

  public error(message: string, meta?: LogMeta): void {
    this.emit('error', message, meta);
  }

  private emit(level: keyof HostLoggerLike, message: string, meta?: LogMeta): void {
    const combinedMeta = meta ? { ...this.context, ...meta } : this.context;
    const target = this.hostLogger?.[level];

    if (typeof target === 'function') {
      try {
        target.call(this.hostLogger, message, combinedMeta);
        return;
      } catch {
        // Fall back to the local structured logger if the host logger throws.
      }
    }

    this.fallback[level](message, meta);
  }
}

let activeService: ServiceInstance | null = null;

function createLifecycleLogger(context?: ActivationContext): Logger {
  const fallback = createLogger({
    context: {
      service: PLUGIN_ID,
    },
  });

  return new HostLoggerAdapter(context?.logger, fallback, {
    service: PLUGIN_ID,
  });
}

function logDisabledState(logger: Logger, issues?: string[]): void {
  logger.warn('Moss plugin installed but not configured');
  logger.warn('Moss plugin installed. Configure it in OpenClaw UI or openclaw.json');
  if (issues && issues.length > 0) {
    logger.warn('Moss plugin configuration issues detected', {
      issues,
    });
  }
}

function logAuthenticationFailure(logger: Logger, error: unknown): void {
  logger.warn('Moss plugin authentication failed; plugin remains disabled', {
    error,
  });
  logger.warn('Verify config.auth credentials and bot account access in Open WebUI');
}

function logFallbackMode(
  logger: Logger,
  reason: 'missing-config' | 'invalid-config' | 'auth-failed' | 'gateway-failed',
  meta?: Record<string, unknown>,
): void {
  logger.warn('Moss plugin running in fallback mode', {
    reason,
    ...meta,
  });
}

function assertValidatedConfig(config: ValidatedPluginConfig | Parameters<typeof validateRuntimeConfig>[0]): asserts config is ValidatedPluginConfig {
  if (config.auth.mode !== 'token' && config.auth.mode !== 'password') {
    throw new Error('validated config does not contain a runtime auth mode');
  }
}

export async function createService(options?: CreateServiceOptions): Promise<ServiceInstance> {
  const runtime = loadRuntimeSettings(process.env);
  const providerSettings = loadEmbeddedProviderSettings(process.env);
  const logger =
    options?.logger ??
    createLogger({
      level: runtime.logLevel,
      context: {
        service: PLUGIN_ID,
      },
    });

  const loaded = await loadPluginConfigFromFile(runtime.configPath);
  let gateway: WebUISocketGateway | null = null;
  let providerServer: Awaited<ReturnType<typeof startProviderServer>> | null = null;
  let startResult: ServiceStartResult | null = null;

  return {
    logger,
    async start(): Promise<ServiceStartResult> {
      if (startResult) {
        return startResult;
      }

      providerServer = await startProviderServer({
        host: providerSettings.host,
        port: providerSettings.port,
        modelsRootDir: providerSettings.modelsRootDir,
        openClawApiUrl: runtime.openClawApiUrl,
        openClawModel: runtime.openClawModel,
        openClawTimeoutMs: runtime.openClawRequestTimeoutMs,
        logger,
      });

      if (!isPluginConfigured(loaded.config)) {
        logDisabledState(logger, loaded.loadIssues);
        logFallbackMode(logger, 'missing-config');
        startResult = {
          active: true,
          reason: 'started',
        };
        return startResult;
      }

      const runtimeIssues = [...loaded.loadIssues, ...validateRuntimeConfig(loaded.config)];
      if (runtimeIssues.length > 0) {
        logDisabledState(logger, runtimeIssues);
        logFallbackMode(logger, 'invalid-config', {
          issues: runtimeIssues,
        });
        startResult = {
          active: true,
          reason: 'started',
        };
        return startResult;
      }

      assertValidatedConfig(loaded.config);
      const config = loaded.config;

      const authSession = createWebUIAuthSession({
        baseUrl: config.baseUrl,
        auth: config.auth,
        logger,
      });

      if (config.auth.mode === 'token') {
        logger.warn('config.auth.mode=token is intended for local testing only; use password mode in production');
      }

      try {
        await authSession.getToken();
      } catch (error) {
        logAuthenticationFailure(logger, error);
        logFallbackMode(logger, 'auth-failed');
        startResult = {
          active: true,
          reason: 'started',
        };
        return startResult;
      }

      try {
        await prepareAttachmentDirectory(config);
        if (config.attachments.enabled) {
          await cleanupStaleDirectories(
            config.attachments.tempDir,
            runtime.staleAttachmentMaxAgeMs,
            logger,
          );
        }
      } catch (error) {
        logFallbackMode(logger, 'gateway-failed', {
          error,
        });
        startResult = {
          active: true,
          reason: 'started',
        };
        return startResult;
      }

      const registry = buildAgentRegistry(config.agents);
      const webUIClient = new WebUIClient(config.baseUrl, authSession, logger);
      const openClawClient = new OpenClawChatClient(
        runtime.openClawApiUrl,
        runtime.openClawModel,
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
        inboundAttachments: new InboundAttachmentService(
          webUIClient,
          config.attachments,
          logger,
        ),
        outboundAttachments: new OutboundAttachmentService(
          webUIClient,
          config.attachments,
          logger,
        ),
        registry,
      });

      gateway = new WebUISocketGateway({
        baseUrl: config.baseUrl,
        authSession,
        allowedChannels: config.allowedChannels,
        botUserId: config.botUserId,
        logger,
        onEvent: async (event) => router.handleEvent(event),
      });

      try {
        await gateway.start();
      } catch (error) {
        await gateway.stop();
        gateway = null;

        if (error instanceof AuthenticationError) {
          logAuthenticationFailure(logger, error);
          logFallbackMode(logger, 'auth-failed');
          startResult = {
            active: true,
            reason: 'started',
          };
          return startResult;
        }

        logFallbackMode(logger, 'gateway-failed', {
          error,
        });
        startResult = {
          active: true,
          reason: 'started',
        };
        return startResult;
      }
      logger.info('Service started', {
        allowedChannelCount: config.allowedChannels.length,
        allowedUserCount: config.allowedUsers.length,
        agentCount: registry.length,
        authMode: config.auth.mode,
      });

      startResult = {
        active: true,
        reason: 'started',
      };
      return startResult;
    },
    async stop() {
      if (!gateway && !providerServer) {
        logger.info('Service stopped');
        return;
      }

      if (gateway) {
        await gateway.stop();
        gateway = null;
      }

      if (providerServer) {
        await providerServer.close();
        providerServer = null;
      }

      startResult = null;
      logger.info('Service stopped');
    },
  };
}

export async function startPlugin(context?: ActivationContext): Promise<void> {
  const logger = createLifecycleLogger(context);

  if (activeService) {
    logger.info('[moss] activate called while plugin is already active');
    return;
  }

  logger.info('[moss] activating plugin');

  try {
    const service = await createService({ logger });
    activeService = service;
    const result = await service.start();

    if (result.active) {
      logger.info('[moss] plugin started');
      return;
    }

    logger.warn('[moss] plugin activated in disabled mode', {
      reason: result.reason,
    });
  } catch (error) {
    activeService = null;
    logger.error('[moss] failed to start', {
      error,
    });
  }
}

export async function stopPlugin(): Promise<void> {
  const service = activeService;
  if (!service) {
    createLifecycleLogger().info('[moss] deactivate called with no active service');
    return;
  }

  const logger = service.logger;
  logger.info('[moss] deactivating plugin');

  try {
    await service.stop();
    logger.info('[moss] plugin stopped');
  } catch (error) {
    logger.error('[moss] failed to stop', {
      error,
    });
  } finally {
    activeService = null;
  }
}
