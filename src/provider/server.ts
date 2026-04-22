import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { OpenClawChatClient } from '../api/openclaw-client.js';
import type { Logger } from '../utils/logger.js';
import { ModelWorkspaceRegistry } from './registry.js';
import {
  MossOpenAIProviderService,
  ProviderRequestError,
} from './service.js';
import type { OpenAIChatCompletionRequest } from './types.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4000;
const MAX_REQUEST_BYTES = 1024 * 1024;

interface ProviderServerOptions {
  host?: string;
  port?: number;
  modelsRootDir?: string;
  openClawApiUrl: string;
  openClawModel: string;
  openClawTimeoutMs: number;
  openClawGatewayToken?: string;
  logger: Logger;
}

interface ProviderServerHandle {
  server: Server;
  close(): Promise<void>;
}

interface JsonErrorBody {
  error: {
    message: string;
    type: string;
    code: string;
  };
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_REQUEST_BYTES) {
      throw new ProviderRequestError(413, 'request_too_large', 'Request body exceeds the 1MB limit');
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ProviderRequestError(400, 'invalid_json', 'Request body is not valid JSON');
  }
}

function toJsonErrorBody(error: ProviderRequestError): JsonErrorBody {
  return {
    error: {
      message: error.message,
      type: 'invalid_request_error',
      code: error.code,
    },
  };
}

export async function startProviderServer(
  options: ProviderServerOptions,
): Promise<ProviderServerHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const logger = options.logger.child({
    component: 'provider-server',
    host,
    port,
  });
  const registryOptions = options.modelsRootDir
    ? { modelsRootDir: options.modelsRootDir, logger }
    : { logger };
  const registry = new ModelWorkspaceRegistry(registryOptions);
  const openClawClient = new OpenClawChatClient(
    options.openClawApiUrl,
    options.openClawModel,
    options.openClawTimeoutMs,
    logger,
    options.openClawGatewayToken,
  );
  const provider = new MossOpenAIProviderService(registry, openClawClient, logger);
  const startupModels = await registry.list();

  const server = createServer(async (request, response) => {
    try {
      if (!request.url) {
        throw new ProviderRequestError(400, 'missing_url', 'Request URL is missing');
      }

      const url = new URL(request.url, `http://${host}:${port}`);

      if (request.method === 'OPTIONS') {
        writeJson(response, 204, null);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/models') {
        const payload = await provider.listModels();
        writeJson(response, 200, payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = (await readJsonBody(request)) as OpenAIChatCompletionRequest;
        const payload = await provider.createChatCompletion(body);
        writeJson(response, 200, payload);
        return;
      }

      throw new ProviderRequestError(404, 'not_found', `Route ${request.method} ${url.pathname} was not found`);
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        writeJson(response, error.status, toJsonErrorBody(error));
        return;
      }

      logger.error('Unhandled provider server error', {
        error,
      });
      writeJson(response, 500, {
        error: {
          message: error instanceof Error ? error.message : 'Internal server error',
          type: 'server_error',
          code: 'internal_error',
        },
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      const actualPort =
        address && typeof address === 'object' && typeof address.port === 'number'
          ? address.port
          : port;
      logger.info('Moss OpenAI-compatible provider started', {
        host,
        port: actualPort,
        modelsRootDir: options.modelsRootDir,
        modelCount: startupModels.length,
        modelIds: startupModels.map((model) => model.id),
      });
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  return {
    server,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
}
