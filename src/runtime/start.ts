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

function assertValidatedConfig(config: ValidatedPluginConfig | Parameters<typeof validateRuntimeConfig>[0]): asserts config is ValidatedPluginConfig {
  if (config.auth.mode !== 'token' && config.auth.mode !== 'password') {
    throw new Error('validated config does not contain a runtime auth mode');
  }
}

export async function createService(options?: CreateServiceOptions): Promise<ServiceInstance> {
  const runtime = loadRuntimeSettings(process.env);
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
  let started = false;

  return {
    logger,
    async start(): Promise<ServiceStartResult> {
      if (started) {
        return {
          active: true,
          reason: 'started',
        };
      }

      if (!isPluginConfigured(loaded.config)) {
        logDisabledState(logger, loaded.loadIssues);
        return {
          active: false,
          reason: 'disabled-unconfigured',
        };
      }

      const runtimeIssues = [...loaded.loadIssues, ...validateRuntimeConfig(loaded.config)];
      if (runtimeIssues.length > 0) {
        logDisabledState(logger, runtimeIssues);
        return {
          active: false,
          reason: 'disabled-invalid-config',
        };
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
        return {
          active: false,
          reason: 'disabled-auth-failed',
        };
      }

      await prepareAttachmentDirectory(config);
      if (config.attachments.enabled) {
        await cleanupStaleDirectories(
          config.attachments.tempDir,
          runtime.staleAttachmentMaxAgeMs,
          logger,
        );
      }

      const registry = buildAgentRegistry(config.agents);
      const webUIClient = new WebUIClient(config.baseUrl, authSession, logger);
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
          return {
            active: false,
            reason: 'disabled-auth-failed',
          };
        }

        throw error;
      }

      started = true;
      logger.info('Service started', {
        allowedChannelCount: config.allowedChannels.length,
        allowedUserCount: config.allowedUsers.length,
        agentCount: registry.length,
        authMode: config.auth.mode,
      });

      return {
        active: true,
        reason: 'started',
      };
    },
    async stop() {
      if (!gateway) {
        logger.info('Service stopped');
        return;
      }

      await gateway.stop();
      gateway = null;
      started = false;
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
