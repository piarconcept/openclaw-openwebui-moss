import { io, type Socket } from 'socket.io-client';

import type { RawChannelEvent } from '../types/messages.js';
import type { Logger } from '../utils/logger.js';
import { IntegrationError } from '../utils/errors.js';

interface SocketGatewayOptions {
  baseUrl: string;
  token: string;
  allowedChannels: readonly string[];
  botUserId: string;
  logger: Logger;
  onEvent: (event: RawChannelEvent) => Promise<void>;
}

export class WebUISocketGateway {
  private socket: Socket | undefined;
  private readonly allowedChannels: Set<string>;

  public constructor(private readonly options: SocketGatewayOptions) {
    this.allowedChannels = new Set(options.allowedChannels);
  }

  public async start(): Promise<void> {
    if (this.socket) {
      return;
    }

    const socket = io(this.options.baseUrl, {
      path: '/ws/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      auth: {
        token: this.options.token,
      },
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.options.logger.info('Connected to Open WebUI Socket.IO');
      socket.emit('user-join', { auth: { token: this.options.token } });
      socket.emit('join-channels', {
        auth: { token: this.options.token },
        channel_ids: Array.from(this.allowedChannels),
      });
    });

    socket.on('disconnect', (reason) => {
      this.options.logger.warn('Socket.IO disconnected', { reason });
    });

    socket.io.on('reconnect_attempt', (attempt) => {
      this.options.logger.warn('Socket.IO reconnect attempt', { attempt });
    });

    socket.on('connect_error', (error) => {
      this.options.logger.error('Socket.IO connect error', { error });
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
        reject(error);
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
    if (event.data?.type !== 'message') {
      return false;
    }

    if (!event.channel_id || !this.allowedChannels.has(event.channel_id)) {
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
