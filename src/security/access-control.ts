import type { RateLimitConfig } from '../types/config.js';
import type { NormalizedInboundMessage } from '../types/messages.js';
import {
  AuthorizationError,
  RateLimitError,
} from '../utils/errors.js';

const WILDCARD_ENTRY = '*';

function allowsAll(entries: readonly string[]): boolean {
  return entries.includes(WILDCARD_ENTRY);
}

export function assertAllowedChannel(channelId: string, allowedChannels: readonly string[]): void {
  if (!allowsAll(allowedChannels) && !allowedChannels.includes(channelId)) {
    throw new AuthorizationError('CHANNEL_NOT_ALLOWED', `Channel ${channelId} is not allowed`, {
      channelId,
    });
  }
}

export function assertAllowedUser(userId: string, allowedUsers: readonly string[]): void {
  if (!allowsAll(allowedUsers) && !allowedUsers.includes(userId)) {
    throw new AuthorizationError('USER_NOT_ALLOWED', `User ${userId} is not allowed`, {
      userId,
    });
  }
}

export interface RateLimitDecision {
  allowed: boolean;
  key: string;
  retryAfterMs: number;
  remaining: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export class BasicRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  public constructor(private readonly config: RateLimitConfig) {}

  public consume(userId: string, channelId: string, now = Date.now()): RateLimitDecision {
    const key = `${userId}:${channelId}`;

    if (!this.config.enabled) {
      return {
        allowed: true,
        key,
        retryAfterMs: 0,
        remaining: Number.POSITIVE_INFINITY,
      };
    }

    this.sweep(now);
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, {
        count: 1,
        resetAt: now + this.config.windowMs,
      });
      return {
        allowed: true,
        key,
        retryAfterMs: 0,
        remaining: Math.max(this.config.maxMessages - 1, 0),
      };
    }

    if (existing.count >= this.config.maxMessages) {
      throw new RateLimitError('RATE_LIMITED', `Rate limit exceeded for ${key}`, {
        key,
        retryAfterMs: existing.resetAt - now,
      });
    }

    existing.count += 1;
    this.buckets.set(key, existing);

    return {
      allowed: true,
      key,
      retryAfterMs: 0,
      remaining: Math.max(this.config.maxMessages - existing.count, 0),
    };
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}

export interface LoopInspectionResult {
  loopDetected: boolean;
  reason?: string;
}

export class LoopProtector {
  private readonly recentOutboundMessages = new Map<string, number>();

  public constructor(
    private readonly botUserId: string,
    private readonly sourceTag = 'openclaw-openwebui-moss',
    private readonly ttlMs = 15 * 60 * 1000,
  ) {}

  public inspect(message: NormalizedInboundMessage, now = Date.now()): LoopInspectionResult {
    this.sweep(now);

    if (message.senderId === this.botUserId) {
      return {
        loopDetected: true,
        reason: 'sender matches botUserId',
      };
    }

    const source = message.meta.source;
    if (typeof source === 'string' && source === this.sourceTag) {
      return {
        loopDetected: true,
        reason: 'message meta source matches plugin source tag',
      };
    }

    if (this.recentOutboundMessages.has(message.id)) {
      return {
        loopDetected: true,
        reason: 'message id exists in outbound loop cache',
      };
    }

    return {
      loopDetected: false,
    };
  }

  public rememberOutboundMessage(messageId: string | undefined, now = Date.now()): void {
    if (!messageId) {
      return;
    }

    this.recentOutboundMessages.set(messageId, now + this.ttlMs);
  }

  private sweep(now: number): void {
    for (const [messageId, expiresAt] of this.recentOutboundMessages.entries()) {
      if (expiresAt <= now) {
        this.recentOutboundMessages.delete(messageId);
      }
    }
  }
}
