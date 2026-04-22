import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';

import type { Logger } from '../utils/logger.js';
import type {
  IndexedModelFile,
  ModelDefinition,
  ModelWorkspaceConfig,
} from './types.js';

const DEFAULT_MAX_CONTEXT_BYTES = 50 * 1024;
const IDENTITY_FILENAME = 'IDENTITY.md';
const CONFIG_FILENAME = 'config.json';

interface ModelWorkspaceRegistryOptions {
  modelsRootDir?: string;
  logger: Logger;
  defaultMaxContextBytes?: number;
}

interface CandidateFile {
  absolutePath: string;
  relativePath: string;
}

function isMarkdownOrTextFile(pathname: string): boolean {
  return pathname.endsWith('.md') || pathname.endsWith('.txt');
}

function bufferToSizedString(content: string, maxBytes: number): { text: string; bytes: number } {
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.byteLength <= maxBytes) {
    return {
      text: content,
      bytes: buffer.byteLength,
    };
  }

  const sliced = buffer.subarray(0, maxBytes).toString('utf8');
  return {
    text: sliced,
    bytes: Buffer.byteLength(sliced, 'utf8'),
  };
}

async function listContextFilesRecursively(
  modelDir: string,
  currentDir = modelDir,
): Promise<CandidateFile[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const candidates: CandidateFile[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listContextFilesRecursively(modelDir, absolutePath);
      candidates.push(...nested);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!isMarkdownOrTextFile(entry.name)) {
      continue;
    }

    if (entry.name === IDENTITY_FILENAME) {
      continue;
    }

    candidates.push({
      absolutePath,
      relativePath: relative(modelDir, absolutePath),
    });
  }

  return candidates;
}

export class ModelWorkspaceRegistry {
  private readonly modelsRootDir: string;
  private readonly logger: Logger;
  private readonly defaultMaxContextBytes: number;
  private models = new Map<string, ModelDefinition>();

  public constructor(options: ModelWorkspaceRegistryOptions) {
    this.modelsRootDir =
      options.modelsRootDir ?? join(homedir(), '.openclaw', 'workspace', 'moss-models');
    this.logger = options.logger.child({
      component: 'model-workspace-registry',
      modelsRootDir: this.modelsRootDir,
    });
    this.defaultMaxContextBytes = options.defaultMaxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES;
  }

  public async refresh(): Promise<ReadonlyMap<string, ModelDefinition>> {
    this.models = await this.scan();
    return this.models;
  }

  public async list(): Promise<ModelDefinition[]> {
    await this.refresh();
    return Array.from(this.models.values()).sort((left, right) => left.id.localeCompare(right.id));
  }

  public async get(modelId: string): Promise<ModelDefinition | undefined> {
    await this.refresh();
    return this.models.get(modelId);
  }

  private async scan(): Promise<Map<string, ModelDefinition>> {
    let entries;
    try {
      entries = await readdir(this.modelsRootDir, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.logger.warn('Models root directory does not exist; serving an empty model list');
        return new Map<string, ModelDefinition>();
      }

      throw error;
    }

    const models = new Map<string, ModelDefinition>();

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) {
        continue;
      }

      const modelDir = join(this.modelsRootDir, entry.name);
      const model = await this.loadModelDirectory(modelDir);
      if (!model) {
        continue;
      }

      models.set(model.id, model);
    }

    return models;
  }

  private async loadModelDirectory(modelDir: string): Promise<ModelDefinition | null> {
    const modelId = basename(modelDir);
    const identityPath = join(modelDir, IDENTITY_FILENAME);

    let identity = '';
    try {
      identity = (await readFile(identityPath, 'utf8')).trim();
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.logger.warn('Skipping model without IDENTITY.md', {
          modelId,
          modelDir,
        });
        return null;
      }

      this.logger.warn('Skipping model because IDENTITY.md could not be read', {
        modelId,
        modelDir,
        error,
      });
      return null;
    }

    if (identity === '') {
      this.logger.warn('Skipping model because IDENTITY.md is empty', {
        modelId,
        modelDir,
      });
      return null;
    }

    const config = await this.readOptionalConfig(modelDir, modelId);
    if (config === null) {
      return null;
    }

    const maxContextBytes =
      typeof config?.limits?.maxContextBytes === 'number' && config.limits.maxContextBytes > 0
        ? Math.floor(config.limits.maxContextBytes)
        : this.defaultMaxContextBytes;

    const files = await this.loadContextFiles(modelDir, maxContextBytes);
    const context = files
      .map((file) => `File: ${file.path}\n${file.content}`)
      .join('\n\n');

    return {
      id: modelId,
      agentId: config?.agentId?.trim() || 'main',
      identity,
      files,
      context,
      workspacePath: modelDir,
      maxContextBytes,
    };
  }

  private async readOptionalConfig(
    modelDir: string,
    modelId: string,
  ): Promise<ModelWorkspaceConfig | null | undefined> {
    const configPath = join(modelDir, CONFIG_FILENAME);

    try {
      const raw = await readFile(configPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.logger.warn('Skipping model because config.json is not an object', {
          modelId,
          configPath,
        });
        return null;
      }

      return parsed as ModelWorkspaceConfig;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }

      this.logger.warn('Skipping model because config.json is invalid', {
        modelId,
        configPath,
        error,
      });
      return null;
    }
  }

  private async loadContextFiles(
    modelDir: string,
    maxContextBytes: number,
  ): Promise<IndexedModelFile[]> {
    const files = await listContextFilesRecursively(modelDir);
    const indexedFiles: IndexedModelFile[] = [];
    let remainingBytes = maxContextBytes;

    for (const file of files) {
      if (remainingBytes <= 0) {
        break;
      }

      const raw = await readFile(file.absolutePath, 'utf8');
      const sized = bufferToSizedString(raw, remainingBytes);
      const bytes = Buffer.byteLength(sized.text, 'utf8');
      if (bytes <= 0) {
        continue;
      }

      indexedFiles.push({
        path: file.relativePath,
        content: sized.text,
        bytes,
        truncated: bytes < Buffer.byteLength(raw, 'utf8'),
      });
      remainingBytes -= bytes;
    }

    return indexedFiles;
  }
}
