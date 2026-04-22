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

function normalizeChatCompletionText(payload: unknown): string {
  if (!isRecord(payload)) {
    return '';
  }

  const choices = payload.choices;
  if (!Array.isArray(choices)) {
    return '';
  }

  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) {
    return '';
  }

  const message = firstChoice.message;
  if (!isRecord(message)) {
    return '';
  }

  return typeof message.content === 'string' ? message.content : '';
}

function summarizeErrorBody(body: string): string {
  const normalized = body.replace(/\s+/gu, ' ').trim();
  if (normalized === '') {
    return '';
  }

  return normalized.length > 300 ? `${normalized.slice(0, 297)}...` : normalized;
}

export class OpenClawChatClient {
  private readonly gatewayToken: string | undefined;

  public constructor(
    private readonly apiUrl: string,
    private readonly model: string,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
    gatewayToken?: string,
  ) {
    const normalizedToken = gatewayToken?.trim();
    this.gatewayToken = normalizedToken ? normalizedToken : undefined;
  }

  public async chat(request: OpenClawChatRequest): Promise<OpenClawChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.gatewayToken) {
        headers.Authorization = `Bearer ${this.gatewayToken}`;
      }
      if (typeof request.correlationId === 'string' && request.correlationId.trim() !== '') {
        headers['X-Correlation-Id'] = request.correlationId;
      }

      const messages =
        Array.isArray(request.messages) && request.messages.length > 0
          ? request.messages
          : typeof request.message === 'string' && request.message.trim() !== ''
            ? [
                {
                  role: 'user' as const,
                  content: request.message,
                },
              ]
            : null;

      if (!messages) {
        throw new IntegrationError(
          'OPENCLAW_CHAT_INVALID_REQUEST',
          'OpenClaw chat request requires message or messages',
        );
      }

      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        const summary = summarizeErrorBody(body);
        throw new IntegrationError(
          'OPENCLAW_CHAT_FAILED',
          summary === ''
            ? `OpenClaw /v1/chat/completions returned HTTP ${response.status}`
            : `OpenClaw /v1/chat/completions returned HTTP ${response.status}: ${summary}`,
          {
            status: response.status,
            body,
          },
        );
      }

      const payload = (await response.json()) as unknown;
      const text = normalizeChatCompletionText(payload);
      if (text === '') {
        throw new IntegrationError(
          'OPENCLAW_CHAT_INVALID',
          'OpenClaw /v1/chat/completions returned an invalid payload',
        );
      }

      return {
        text,
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
