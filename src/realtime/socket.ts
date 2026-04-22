import { io, type Socket } from 'socket.io-client';

import type { WebUIAuthSession } from '../api/webui-auth.js';
import type { RawChannelEvent } from '../types/messages.js';
import type { Logger } from '../utils/logger.js';
import { AuthenticationError, IntegrationError } from '../utils/errors.js';

interface SocketGatewayOptions {
  baseUrl: string;
  authSession: WebUIAuthSession;
  allowedChannels: readonly string[];
  botUserId: string;
  logger: Logger;
  onEvent: (event: RawChannelEvent) => Promise<void>;
}

const WILDCARD_ENTRY = '*';

function looksLikeAuthenticationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(401|unauthori[sz]ed|auth|token|jwt|session|sign\s*in|login)/iu.test(message);
}

function toSocketAuthenticationError(error: unknown): AuthenticationError {
  return new AuthenticationError(
    'WEBUI_SOCKET_AUTH_FAILED',
    'Open WebUI Socket.IO authentication failed',
    {
      error: error instanceof Error ? error.message : String(error),
    },
  );
}

export class WebUISocketGateway {
  private socket: Socket | undefined;
  private readonly allowedChannels: Set<string>;
  private readonly allowsAllChannels: boolean;

  public constructor(private readonly options: SocketGatewayOptions) {
    this.allowedChannels = new Set(options.allowedChannels);
    this.allowsAllChannels = this.allowedChannels.has(WILDCARD_ENTRY);
  }

  public async start(): Promise<void> {
    if (this.socket) {
      return;
    }

    let forceTokenRefresh = false;
    let lastHandshakeToken = '';
    let lastAuthError: AuthenticationError | null = null;
    let hasConnectedOnce = false;

    const socket = io(this.options.baseUrl, {
      path: '/ws/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      auth: (cb) => {
        void (async () => {
          try {
            lastHandshakeToken = await this.options.authSession.getToken({
              forceRefresh: forceTokenRefresh && this.options.authSession.canRefresh(),
            });
            forceTokenRefresh = false;
            lastAuthError = null;
            cb({ token: lastHandshakeToken });
          } catch (error) {
            forceTokenRefresh = false;
            lastHandshakeToken = '';
            lastAuthError =
              error instanceof AuthenticationError ? error : toSocketAuthenticationError(error);
            cb({ token: '' });
          }
        })();
      },
    });
    this.socket = socket;

    socket.on('connect', () => {
      hasConnectedOnce = true;
      this.options.logger.info('Connected to Open WebUI Socket.IO');
      socket.emit('user-join', { auth: { token: lastHandshakeToken } });
      socket.emit('join-channels', {
        auth: { token: lastHandshakeToken },
        channel_ids: this.allowsAllChannels ? [WILDCARD_ENTRY] : Array.from(this.allowedChannels),
      });
    });

    socket.on('disconnect', (reason) => {
      this.options.logger.warn('Socket.IO disconnected', { reason });
    });

    socket.io.on('reconnect_attempt', (attempt) => {
      if (this.options.authSession.canRefresh() && !this.options.authSession.isDisabled()) {
        forceTokenRefresh = true;
        this.options.authSession.invalidate();
      }

      this.options.logger.warn('Socket.IO reconnect attempt', {
        attempt,
        refreshAuth: this.options.authSession.canRefresh(),
      });
    });

    socket.on('connect_error', (error) => {
      const authError =
        lastAuthError ??
        (looksLikeAuthenticationFailure(error) ? toSocketAuthenticationError(error) : null);

      if (hasConnectedOnce && authError && this.options.authSession.canRefresh()) {
        forceTokenRefresh = true;
        this.options.authSession.invalidate();
        this.options.logger.warn('Socket.IO auth error detected, refreshing session for reconnect', {
          error: authError,
        });
      }

      this.options.logger.error('Socket.IO connect error', {
        error: authError ?? error,
      });
    });

    socket.io.on('reconnect_failed', () => {
      this.options.logger.error('Socket.IO reconnection failed permanently');
    });

    socket.on('events:channel', (event: RawChannelEvent) => {
      if (!this.shouldForward(event)) {
        return;
      }

      void this.options.onEvent(event).catch((error) => {
        this.options.logger.error('Unhandled channel event failure', { error });
      });
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new IntegrationError(
            'SOCKET_CONNECT_TIMEOUT',
            'Timed out connecting to Open WebUI Socket.IO',
          ),
        );
      }, 15000);

      socket.once('connect', () => {
        clearTimeout(timeout);
        resolve();
      });

      socket.once('connect_error', (error) => {
        clearTimeout(timeout);
        const authError =
          lastAuthError ??
          (looksLikeAuthenticationFailure(error) ? toSocketAuthenticationError(error) : null);
        reject(authError ?? error);
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.socket) {
      return;
    }

    this.socket.disconnect();
    this.socket = undefined;
  }

  private shouldForward(event: RawChannelEvent): boolean {
    if (this.options.authSession.isDisabled()) {
      this.options.logger.warn('Dropped event before router because authentication is disabled', {
        channelId: event.channel_id,
      });
      return false;
    }

    if (event.data?.type !== 'message') {
      return false;
    }

    if (
      !event.channel_id ||
      (!this.allowsAllChannels && !this.allowedChannels.has(event.channel_id))
    ) {
      this.options.logger.debug('Dropped event before router because channel is not allowed', {
        channelId: event.channel_id,
      });
      return false;
    }

    const senderId = event.data.data?.user_id;
    if (!senderId) {
      this.options.logger.debug('Dropped malformed event before router', {
        channelId: event.channel_id,
      });
      return false;
    }

    if (senderId === this.options.botUserId) {
      this.options.logger.debug('Dropped bot-authored event before router', {
        channelId: event.channel_id,
      });
      return false;
    }

    return true;
  }
}
