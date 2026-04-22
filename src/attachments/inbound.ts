import { join } from 'node:path';

import type { WebUIClient } from '../api/webui-client.js';
import { createRequestTempDir, sanitizePathSegment } from './cleanup.js';
import type { AttachmentsConfig } from '../types/config.js';
import type { InboundAttachment, WebUIFileDescriptor } from '../types/messages.js';
import type { Logger } from '../utils/logger.js';
import { AttachmentError } from '../utils/errors.js';

export interface InboundAttachmentResult {
  requestDir?: string;
  attachments: InboundAttachment[];
}

export class InboundAttachmentService {
  public constructor(
    private readonly client: WebUIClient,
    private readonly config: AttachmentsConfig,
    private readonly logger: Logger,
  ) {}

  public async materialize(
    attachments: readonly WebUIFileDescriptor[],
    correlationId: string,
  ): Promise<InboundAttachmentResult> {
    if (!this.config.enabled || attachments.length === 0) {
      return { attachments: [] };
    }

    const requestDir = await createRequestTempDir(this.config.tempDir, correlationId);
    const materialized: InboundAttachment[] = [];

    for (const attachment of attachments) {
      if (!attachment.id) {
        throw new AttachmentError('INBOUND_ATTACHMENT_INVALID', 'Attachment is missing an id');
      }

      if (typeof attachment.size === 'number' && attachment.size > this.config.maxBytes) {
        throw new AttachmentError(
          'INBOUND_ATTACHMENT_TOO_LARGE',
          `Attachment ${attachment.id} exceeds maxBytes before download`,
          {
            fileId: attachment.id,
            bytes: attachment.size,
            maxBytes: this.config.maxBytes,
          },
        );
      }

      const safeFilename = sanitizePathSegment(
        attachment.filename ?? attachment.name ?? `file-${attachment.id}`,
      );
      const targetPath = join(requestDir, safeFilename);
      const downloaded = await this.client.downloadAttachmentToFile(
        attachment.id,
        targetPath,
        this.config.maxBytes,
      );

      materialized.push({
        fileId: attachment.id,
        path: targetPath,
        filename: downloaded.filename ?? safeFilename,
        ...(downloaded.mimeType ? { mimeType: downloaded.mimeType } : {}),
        bytes: downloaded.bytes,
      });
    }

    this.logger.info('Inbound attachments materialized', {
      correlationId,
      attachmentCount: materialized.length,
    });

    return {
      requestDir,
      attachments: materialized,
    };
  }
}
