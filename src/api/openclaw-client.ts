import type { OpenClawChatRequest, OpenClawChatResponse } from '../types/messages.js';
import type { Logger } from '../utils/logger.js';
import { IntegrationError } from '../utils/errors.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAttachments(payload: Record<string, unknown>): OpenClawChatResponse['attachments'] {
  const candidates = [payload.attachments, payload.files, payload.media].find((value) =>
    Array.isArray(value),
  );

  if (!Array.isArray(candidates)) {
    return [];
  }

  return candidates.flatMap((entry) => {
    if (typeof entry === 'string') {
      return [{ path: entry }];
    }

    if (!isRecord(entry)) {
      return [];
    }

    const pathValue = entry.path ?? entry.filePath ?? entry.file_path;
    if (typeof pathValue !== 'string' || pathValue.trim() === '') {
      return [];
    }

    const filename = typeof entry.filename === 'string' ? entry.filename : undefined;
    const mimeType =
      typeof entry.mimeType === 'string'
        ? entry.mimeType
        : typeof entry.mime_type === 'string'
          ? entry.mime_type
          : typeof entry.type === 'string'
            ? entry.type
            : undefined;

    return [
      {
        path: pathValue,
        ...(filename ? { filename } : {}),
        ...(mimeType ? { mimeType } : {}),
      },
    ];
  });
}

function normalizeText(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }

  if (!isRecord(payload)) {
    return '';
  }

  const candidates = [payload.reply, payload.message, payload.text, payload.output];
  const text = candidates.find((value) => typeof value === 'string');
  return typeof text === 'string' ? text : '';
}

export class OpenClawChatClient {
  public constructor(
    private readonly apiUrl: string,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
  ) {}

  public async chat(request: OpenClawChatRequest): Promise<OpenClawChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (typeof request.correlationId === 'string' && request.correlationId.trim() !== '') {
        headers['X-Correlation-Id'] = request.correlationId;
      }

      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new IntegrationError('OPENCLAW_CHAT_FAILED', 'OpenClaw /api/chat returned an error', {
          status: response.status,
          body: await response.text(),
        });
      }

      const payload = (await response.json()) as unknown;
      if (!isRecord(payload) && typeof payload !== 'string') {
        throw new IntegrationError('OPENCLAW_CHAT_INVALID', 'OpenClaw /api/chat returned an invalid payload');
      }

      return {
        text: normalizeText(payload),
        attachments: isRecord(payload) ? normalizeAttachments(payload) : [],
        raw: payload,
      };
    } catch (error) {
      this.logger.error('OpenClaw chat request failed', {
        error,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
