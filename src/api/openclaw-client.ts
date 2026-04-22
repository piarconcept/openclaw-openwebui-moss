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

function resolveOpenClawAgentTarget(agentId: string): string {
  const normalized = agentId.trim();
  if (normalized === '' || normalized === 'default') {
    return 'openclaw/default';
  }

  return `openclaw/${normalized}`;
}

function summarizeErrorBody(body: string): string {
  const normalized = body.replace(/\s+/gu, ' ').trim();
  if (normalized === '') {
    return '';
  }

  return normalized.length > 300 ? `${normalized.slice(0, 297)}...` : normalized;
}

function buildUpstreamErrorMessage(status: number, body: string): string {
  const summary = summarizeErrorBody(body);

  if (status === 404 && summary === 'Not Found') {
    return (
      'OpenClaw /v1/chat/completions returned HTTP 404: Not Found. ' +
      'The Gateway OpenAI-compatible chat endpoint is likely disabled; enable ' +
      'gateway.http.endpoints.chatCompletions.enabled in openclaw.json'
    );
  }

  return summary === ''
    ? `OpenClaw /v1/chat/completions returned HTTP ${status}`
    : `OpenClaw /v1/chat/completions returned HTTP ${status}: ${summary}`;
}

export class OpenClawChatClient {
  private readonly gatewayToken: string | undefined;

  public constructor(
    private readonly apiUrl: string,
    private readonly backendModel: string,
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
      if (this.backendModel.trim() !== '') {
        headers['x-openclaw-model'] = this.backendModel;
      }
      if (typeof request.sessionKey === 'string' && request.sessionKey.trim() !== '') {
        headers['x-openclaw-session-key'] = request.sessionKey;
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
          model: resolveOpenClawAgentTarget(request.agentId),
          messages,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new IntegrationError(
          'OPENCLAW_CHAT_FAILED',
          buildUpstreamErrorMessage(response.status, body),
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
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`OpenClaw chat request failed: ${message}`, {
        error,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
