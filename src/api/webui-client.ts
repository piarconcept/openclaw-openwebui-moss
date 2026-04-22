import { createWriteStream, openAsBlob } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import type { Logger } from '../utils/logger.js';
import { AttachmentError, AuthenticationError, IntegrationError } from '../utils/errors.js';
import type { UploadedWebUIFile, WebUIMessage } from '../types/messages.js';
import type { WebUIAuthSession } from './webui-auth.js';

interface PostMessageInput {
  channelId: string;
  content: string;
  parentId?: string;
  replyToId?: string;
  data?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

interface UploadAttachmentOptions {
  filename?: string;
  mimeType?: string;
  maxBytes: number;
}

interface AuthorizedRequestOptions {
  action: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFilenameFromContentDisposition(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }

  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/iu);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const asciiMatch = header.match(/filename="?([^";]+)"?/iu);
  return asciiMatch?.[1];
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key];
  return typeof value === 'string' ? value : undefined;
}

async function readResponseDetail(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get('content-type') ?? '';

  try {
    if (contentType.includes('application/json')) {
      const body = (await response.json()) as { detail?: unknown; message?: unknown };
      if (typeof body.detail === 'string' && body.detail.trim() !== '') {
        return body.detail.trim();
      }
      if (typeof body.message === 'string' && body.message.trim() !== '') {
        return body.message.trim();
      }
      return undefined;
    }

    const text = (await response.text()).trim();
    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

export function wrapUploadedFile(uploaded: UploadedWebUIFile): Record<string, unknown> {
  const meta = isRecord(uploaded.meta) ? uploaded.meta : undefined;
  return {
    type: 'file',
    file: uploaded,
    id: uploaded.id,
    url: uploaded.id,
    name:
      uploaded.filename ?? metaString(meta, 'name') ?? uploaded.name ?? `file-${uploaded.id}`,
    collection_name: metaString(meta, 'collection_name') ?? '',
    content_type:
      metaString(meta, 'content_type') ??
      uploaded.type ??
      uploaded.mime_type ??
      'application/octet-stream',
    status: 'uploaded',
    size: uploaded.size ?? 0,
  };
}

export class WebUIClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly authSession: WebUIAuthSession,
    private readonly logger: Logger,
  ) {}

  public async postMessage(input: PostMessageInput): Promise<WebUIMessage> {
    const response = await this.requestWithAuth(
      (token) =>
        fetch(`${this.baseUrl}/api/v1/channels/${input.channelId}/messages/post`, {
          method: 'POST',
          headers: this.headers(token, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            content: input.content,
            ...(input.parentId ? { parent_id: input.parentId } : {}),
            ...(input.replyToId ? { reply_to_id: input.replyToId } : {}),
            data: input.data ?? {},
            meta: input.meta ?? {},
          }),
        }),
      {
        action: `posting a message to channel ${input.channelId}`,
      },
    );

    if (!response.ok) {
      throw new IntegrationError(
        'WEBUI_POST_FAILED',
        `Failed to post message to channel ${input.channelId}`,
        {
          channelId: input.channelId,
          status: response.status,
          body: await response.text(),
        },
      );
    }

    const message = (await response.json()) as WebUIMessage;
    this.logger.debug('Posted message to Open WebUI', {
      channelId: input.channelId,
      messageId: message.id,
    });
    return message;
  }

  public async uploadAttachment(
    filePath: string,
    options: UploadAttachmentOptions,
  ): Promise<UploadedWebUIFile> {
    const fileStat = await stat(filePath);
    if (fileStat.size > options.maxBytes) {
      throw new AttachmentError(
        'OUTBOUND_ATTACHMENT_TOO_LARGE',
        `Attachment ${filePath} exceeds maxBytes`,
        {
          filePath,
          bytes: fileStat.size,
          maxBytes: options.maxBytes,
        },
      );
    }

    const response = await this.requestWithAuth(
      async (token) => {
        const blob = await openAsBlob(filePath, {
          type: options.mimeType ?? 'application/octet-stream',
        });
        const form = new FormData();
        form.append('file', blob, options.filename ?? basename(filePath));

        return fetch(`${this.baseUrl}/api/v1/files/`, {
          method: 'POST',
          headers: this.headers(token),
          body: form,
        });
      },
      {
        action: `uploading attachment ${filePath}`,
      },
    );

    if (!response.ok) {
      throw new IntegrationError('WEBUI_UPLOAD_FAILED', `Failed to upload attachment ${filePath}`, {
        filePath,
        status: response.status,
        body: await response.text(),
      });
    }

    const uploaded = (await response.json()) as UploadedWebUIFile;
    this.logger.debug('Uploaded attachment to Open WebUI', {
      filePath,
      fileId: uploaded.id,
    });
    return uploaded;
  }

  public async downloadAttachmentToFile(
    fileId: string,
    destinationPath: string,
    maxBytes: number,
  ): Promise<{ filename?: string; mimeType?: string; bytes: number }> {
    const response = await this.requestWithAuth(
      (token) =>
        fetch(`${this.baseUrl}/api/v1/files/${fileId}/content`, {
          headers: this.headers(token),
        }),
      {
        action: `downloading attachment ${fileId}`,
      },
    );

    if (!response.ok) {
      throw new IntegrationError('WEBUI_DOWNLOAD_FAILED', `Failed to download attachment ${fileId}`, {
        fileId,
        status: response.status,
        body: await response.text(),
      });
    }

    const declaredLengthHeader = response.headers.get('content-length');
    if (declaredLengthHeader) {
      const declaredLength = Number.parseInt(declaredLengthHeader, 10);
      if (Number.isInteger(declaredLength) && declaredLength > maxBytes) {
        throw new AttachmentError(
          'INBOUND_ATTACHMENT_TOO_LARGE',
          `Attachment ${fileId} exceeds maxBytes before download`,
          {
            fileId,
            bytes: declaredLength,
            maxBytes,
          },
        );
      }
    }

    if (!response.body) {
      throw new IntegrationError('WEBUI_DOWNLOAD_FAILED', `Attachment ${fileId} returned no body`, {
        fileId,
      });
    }

    const fileStream = createWriteStream(destinationPath, { flags: 'w' });
    const source = Readable.fromWeb(response.body as unknown as NodeReadableStream);
    let totalBytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk));
        totalBytes += bytes;
        if (totalBytes > maxBytes) {
          callback(
            new AttachmentError(
              'INBOUND_ATTACHMENT_TOO_LARGE',
              `Attachment ${fileId} exceeded maxBytes while streaming`,
              {
                fileId,
                bytes: totalBytes,
                maxBytes,
              },
            ),
          );
          return;
        }

        callback(null, chunk);
      },
    });

    try {
      await pipeline(source, limiter, fileStream);
    } catch (error) {
      await rm(destinationPath, { force: true });
      throw error;
    }

    const filename =
      parseFilenameFromContentDisposition(response.headers.get('content-disposition')) ??
      `file-${fileId}`;
    const mimeType = response.headers.get('content-type') ?? undefined;
    this.logger.debug('Downloaded attachment from Open WebUI', {
      fileId,
      bytes: totalBytes,
    });

    return {
      filename,
      ...(mimeType ? { mimeType } : {}),
      bytes: totalBytes,
    };
  }

  private async requestWithAuth(
    buildRequest: (token: string) => Promise<Response>,
    options: AuthorizedRequestOptions,
  ): Promise<Response> {
    const token = await this.authSession.getToken();
    let response = await buildRequest(token);

    if (response.status !== 401) {
      return response;
    }

    if (!this.authSession.canRefresh()) {
      const detail = await readResponseDetail(response);
      const authError = new AuthenticationError(
        'WEBUI_AUTH_UNAUTHORIZED',
        'Open WebUI rejected the configured testing token',
        {
          action: options.action,
          mode: this.authSession.mode,
          status: response.status,
          ...(detail ? { detail } : {}),
        },
      );
      this.authSession.disable(authError);
      throw authError;
    }

    this.logger.warn('Open WebUI request returned 401, refreshing session and retrying once', {
      action: options.action,
      mode: this.authSession.mode,
    });
    this.authSession.invalidate();

    let refreshedToken: string;
    try {
      refreshedToken = await this.authSession.getToken({ forceRefresh: true });
    } catch (error) {
      if (error instanceof AuthenticationError) {
        this.authSession.disable(error);
      }
      throw error;
    }

    response = await buildRequest(refreshedToken);
    if (response.status === 401) {
      const detail = await readResponseDetail(response);
      const authError = new AuthenticationError(
        'WEBUI_AUTH_UNAUTHORIZED',
        'Open WebUI rejected refreshed authentication while retrying the request',
        {
          action: options.action,
          mode: this.authSession.mode,
          status: response.status,
          ...(detail ? { detail } : {}),
        },
      );
      this.authSession.disable(authError);
      throw authError;
    }

    return response;
  }

  private headers(token: string, extraHeaders?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    };
  }
}
