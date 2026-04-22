export interface ModelWorkspaceLimits {
  maxContextBytes?: number;
}

export interface ModelWorkspaceConfig {
  agentId?: string;
  limits?: ModelWorkspaceLimits;
}

export interface IndexedModelFile {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface ModelDefinition {
  id: string;
  agentId: string;
  identity: string;
  files: IndexedModelFile[];
  context: string;
  workspacePath: string;
  maxContextBytes: number;
}

export interface OpenAIChatMessageContentPart {
  type: string;
  text?: string;
}

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIChatMessageContentPart[] | null;
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  [key: string]: unknown;
}
