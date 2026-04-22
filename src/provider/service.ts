import { randomUUID } from 'node:crypto';

import type { OpenClawChatRequest, OpenClawChatResponse } from '../types/messages.js';
import { createCorrelationId, type Logger } from '../utils/logger.js';
import type { ModelWorkspaceRegistry } from './registry.js';
import type {
  ModelDefinition,
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
} from './types.js';

interface OpenAIModelListEntry {
  id: string;
  object: 'model';
}

interface OpenAIModelListResponse {
  object: 'list';
  data: OpenAIModelListEntry[];
}

interface OpenAIChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: 'stop';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenClawChatClientLike {
  chat(request: OpenClawChatRequest): Promise<OpenClawChatResponse>;
}

export class ProviderRequestError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

function estimateTokenCount(text: string): number {
  if (text.trim() === '') {
    return 0;
  }

  return Math.ceil(text.length / 4);
}

function extractTextContent(content: OpenAIChatMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('');
}

function extractLastUserMessage(messages: OpenAIChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user') {
      continue;
    }

    const text = extractTextContent(message.content).trim();
    if (text !== '') {
      return text;
    }
  }

  return '';
}

export function buildModelPrompt(model: ModelDefinition, userMessage: string): string {
  const segments = [model.identity.trim()];

  if (model.context.trim() !== '') {
    segments.push(`Context:\n${model.context}`);
  }

  segments.push(`User:\n${userMessage.trim()}`);
  return segments.join('\n\n');
}

export class MossOpenAIProviderService {
  private readonly logger: Logger;

  public constructor(
    private readonly registry: ModelWorkspaceRegistry,
    private readonly openClawClient: OpenClawChatClientLike,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: 'moss-openai-provider' });
  }

  public async listModels(): Promise<OpenAIModelListResponse> {
    const models = await this.registry.list();

    return {
      object: 'list',
      data: models.map((model) => ({
        id: model.id,
        object: 'model',
      })),
    };
  }

  public async createChatCompletion(
    request: OpenAIChatCompletionRequest,
  ): Promise<OpenAIChatCompletionResponse> {
    if (request.stream === true) {
      throw new ProviderRequestError(
        400,
        'stream_not_supported',
        'Streaming responses are not supported by this provider yet',
      );
    }

    if (typeof request.model !== 'string' || request.model.trim() === '') {
      throw new ProviderRequestError(400, 'missing_model', 'Request model is required');
    }

    if (!Array.isArray(request.messages)) {
      throw new ProviderRequestError(400, 'invalid_messages', 'Request messages must be an array');
    }

    const model = await this.registry.get(request.model);
    if (!model) {
      throw new ProviderRequestError(404, 'model_not_found', `Model ${request.model} was not found`);
    }

    const lastUserMessage = extractLastUserMessage(request.messages);
    if (lastUserMessage === '') {
      throw new ProviderRequestError(
        400,
        'missing_user_message',
        'At least one user message with text content is required',
      );
    }

    const prompt = buildModelPrompt(model, lastUserMessage);
    const correlationId = createCorrelationId(model.id);
    const sessionKey = `openai-provider:${model.id}:${randomUUID()}`;

    let response: OpenClawChatResponse;
    try {
      response = await this.openClawClient.chat({
        agentId: model.agentId || 'main',
        sessionKey,
        correlationId,
        message: prompt,
        metadata: {
          provider: 'moss-openai-provider',
          modelId: model.id,
          workspacePath: model.workspacePath,
        },
        attachments: [],
      });
    } catch (error) {
      this.logger.error('OpenClaw call failed while serving chat completion', {
        error,
        modelId: model.id,
        correlationId,
      });
      throw new ProviderRequestError(
        502,
        'openclaw_chat_failed',
        error instanceof Error ? error.message : 'OpenClaw chat request failed',
      );
    }

    const reply = response.text.trim();
    const created = Math.floor(Date.now() / 1000);
    const promptTokens = estimateTokenCount(prompt);
    const completionTokens = estimateTokenCount(reply);

    return {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created,
      model: model.id,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: reply,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }
}
