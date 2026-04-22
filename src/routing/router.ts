import type { WebUIClient } from '../api/webui-client.js';
import { wrapUploadedFile } from '../api/webui-client.js';
import type { OpenClawChatClient } from '../api/openclaw-client.js';
import type { InboundAttachmentService } from '../attachments/inbound.js';
import { cleanupPath } from '../attachments/cleanup.js';
import type { OutboundAttachmentService } from '../attachments/outbound.js';
import { PLUGIN_ID } from '../config.js';
import type { AgentRouter } from './agent-routing.js';
import { assertAllowedChannel, assertAllowedUser } from '../security/access-control.js';
import type { BasicRateLimiter, LoopProtector } from '../security/access-control.js';
import { evaluateMentionPolicy } from '../security/mention-policy.js';
import type { ValidatedPluginConfig } from '../types/config.js';
import type { NormalizedInboundMessage, RawChannelEvent } from '../types/messages.js';
import { AuthorizationError, RateLimitError, RoutingError } from '../utils/errors.js';
import { createCorrelationId, type Logger } from '../utils/logger.js';

interface RouterDependencies {
  config: ValidatedPluginConfig;
  logger: Logger;
  webUIClient: WebUIClient;
  openClawClient: OpenClawChatClient;
  rateLimiter: BasicRateLimiter;
  loopProtector: LoopProtector;
  agentRouter: AgentRouter;
  inboundAttachments: InboundAttachmentService;
  outboundAttachments: OutboundAttachmentService;
  registry: Parameters<typeof evaluateMentionPolicy>[0]['registry'];
}

export function normalizeIncomingMessage(event: RawChannelEvent): NormalizedInboundMessage | null {
  if (event.data?.type !== 'message' || !event.data.data) {
    return null;
  }

  const message = event.data.data;
  if (!message.id || !event.channel_id || !message.user_id) {
    return null;
  }

  return {
    id: message.id,
    channelId: event.channel_id,
    ...(event.channel?.name ? { channelName: event.channel.name } : {}),
    channelType: event.channel?.type ?? null,
    senderId: message.user_id,
    senderName: event.user?.name ?? message.user?.name ?? message.user_id,
    text: message.content ?? '',
    createdAt: message.created_at ?? Date.now(),
    ...(message.reply_to_id ? { replyToId: message.reply_to_id } : {}),
    ...(message.parent_id ? { parentId: message.parent_id } : {}),
    meta: message.meta ?? {},
    attachments: Array.isArray(message.data?.files) ? message.data.files : [],
    rawEvent: event,
  };
}

export class SecureMessageRouter {
  public constructor(private readonly dependencies: RouterDependencies) {}

  public async handleEvent(event: RawChannelEvent): Promise<void> {
    const normalized = normalizeIncomingMessage(event);
    if (!normalized) {
      return;
    }

    const correlationId = createCorrelationId(normalized.id);
    const log = this.dependencies.logger.child({
      correlationId,
      channelId: normalized.channelId,
      messageId: normalized.id,
      userId: normalized.senderId,
    });

    let requestDir: string | undefined;

    try {
      const loopInspection = this.dependencies.loopProtector.inspect(normalized);
      if (loopInspection.loopDetected) {
        log.info('Dropped loop-protected message', {
          reason: loopInspection.reason,
        });
        return;
      }

      assertAllowedChannel(normalized.channelId, this.dependencies.config.allowedChannels);
      assertAllowedUser(normalized.senderId, this.dependencies.config.allowedUsers);
      const rateLimit = this.dependencies.rateLimiter.consume(
        normalized.senderId,
        normalized.channelId,
      );

      const mentionDecision = evaluateMentionPolicy({
        text: normalized.text,
        botUserId: this.dependencies.config.botUserId,
        requireMention: this.dependencies.config.requireMention,
        registry: this.dependencies.registry,
      });

      if (!mentionDecision.accepted) {
        log.info('Rejected by mention policy', {
          reason: mentionDecision.reason,
          botMentioned: mentionDecision.botMentioned,
          matchedTriggers: mentionDecision.matchedTriggers.map((entry) => entry.trigger),
        });
        return;
      }

      const agentResolution = this.dependencies.agentRouter.resolve(normalized, mentionDecision);
      const agentLog = log.child({
        agentId: agentResolution.agentId,
        sessionKey: agentResolution.sessionKey,
        rateLimitRemaining: rateLimit.remaining,
      });

      const inboundAttachments = await this.dependencies.inboundAttachments.materialize(
        normalized.attachments,
        correlationId,
      );
      requestDir = inboundAttachments.requestDir;

      const response = await this.dependencies.openClawClient.chat({
        agentId: agentResolution.agentId,
        sessionKey: agentResolution.sessionKey,
        correlationId,
        message: normalized.text,
        metadata: {
          channelId: normalized.channelId,
          channelType: normalized.channelType,
          messageId: normalized.id,
          senderId: normalized.senderId,
          senderName: normalized.senderName,
          parentId: normalized.parentId,
          replyToId: normalized.replyToId,
          botMentioned: mentionDecision.botMentioned,
          matchedTriggers: mentionDecision.matchedTriggers.map((entry) => entry.trigger),
          routeSource: agentResolution.source,
          correlationId,
        },
        attachments: inboundAttachments.attachments.map((attachment) => ({
          path: attachment.path,
          filename: attachment.filename,
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          bytes: attachment.bytes,
        })),
      });

      const uploadedFiles = await this.dependencies.outboundAttachments.uploadAll(
        response.attachments,
      );
      const content = response.text.trim() || (uploadedFiles.length > 0 ? ' ' : '');

      if (!content && uploadedFiles.length === 0) {
        agentLog.warn('OpenClaw response was empty; nothing to post back');
        return;
      }

      const postMessageInput = {
        channelId: normalized.channelId,
        content: content || ' ',
        replyToId: normalized.id,
        ...(normalized.parentId ? { parentId: normalized.parentId } : {}),
        ...(uploadedFiles.length > 0
          ? { data: { files: uploadedFiles.map((file) => wrapUploadedFile(file)) } }
          : {}),
        meta: {
          source: PLUGIN_ID,
          correlationId,
          agentId: agentResolution.agentId,
          replyToMessageId: normalized.id,
        },
      };

      const posted = await this.dependencies.webUIClient.postMessage(postMessageInput);
      this.dependencies.loopProtector.rememberOutboundMessage(posted.id);
      agentLog.info('Posted reply to Open WebUI', {
        replyMessageId: posted.id,
        uploadedAttachmentCount: uploadedFiles.length,
      });
    } catch (error) {
      if (error instanceof AuthorizationError || error instanceof RoutingError) {
        log.info('Message rejected', { error });
        return;
      }

      if (error instanceof RateLimitError) {
        log.warn('Rate limit hit', { error });
        return;
      }

      log.error('Message processing failed', { error });
    } finally {
      await cleanupPath(requestDir);
    }
  }
}
