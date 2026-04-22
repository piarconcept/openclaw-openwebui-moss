export type ChannelEventType =
  | 'message'
  | 'message:update'
  | 'message:delete'
  | 'message:reaction:add'
  | 'message:reaction:remove'
  | 'channel:created';

export interface WebUIUserRef {
  id: string;
  name?: string;
  role?: string;
}

export interface WebUIChannelRef {
  id: string;
  name?: string;
  type: string | null;
}

export interface WebUIFileDescriptor {
  id: string;
  name?: string;
  filename?: string;
  type?: string;
  mime_type?: string;
  size?: number;
}

export interface WebUIMessageData {
  files?: WebUIFileDescriptor[];
  [key: string]: unknown;
}

export interface WebUIMessage {
  id: string;
  channel_id: string;
  user_id: string;
  content: string;
  data?: WebUIMessageData;
  meta?: Record<string, unknown>;
  reply_to_id?: string | null;
  parent_id?: string | null;
  created_at?: number;
  user?: WebUIUserRef;
}

export interface RawChannelEvent {
  channel_id: string;
  message_id: string;
  data: {
    type: ChannelEventType;
    data?: WebUIMessage;
  };
  user?: WebUIUserRef;
  channel?: WebUIChannelRef;
}

export interface NormalizedInboundMessage {
  id: string;
  channelId: string;
  channelName?: string;
  channelType: string | null;
  senderId: string;
  senderName: string;
  text: string;
  createdAt: number;
  replyToId?: string;
  parentId?: string;
  meta: Record<string, unknown>;
  attachments: WebUIFileDescriptor[];
  rawEvent: RawChannelEvent;
}

export interface InboundAttachment {
  fileId: string;
  path: string;
  filename: string;
  mimeType?: string;
  bytes: number;
}

export interface OutboundAttachment {
  path: string;
  filename?: string;
  mimeType?: string;
}

export interface TriggerMatch {
  agentKey: string;
  agentId: string;
  trigger: string;
}

export interface MentionPolicyDecision {
  accepted: boolean;
  botMentioned: boolean;
  matchedTriggers: TriggerMatch[];
  reason?: string;
}

export interface AgentResolution {
  agentKey: string;
  agentId: string;
  bindingKey: string;
  sessionKey: string;
  source: 'binding' | 'trigger' | 'channel';
}

export interface OpenClawChatRequest {
  agentId: string;
  message?: string;
  messages?: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
  }>;
  sessionKey?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  attachments?: Array<{
    path: string;
    filename: string;
    mimeType?: string;
    bytes: number;
  }>;
}

export interface OpenClawChatResponse {
  text: string;
  attachments: OutboundAttachment[];
  raw: unknown;
}

export interface UploadedWebUIFile {
  id: string;
  name?: string;
  filename?: string;
  type?: string;
  mime_type?: string;
  size?: number;
  meta?: Record<string, unknown>;
}
