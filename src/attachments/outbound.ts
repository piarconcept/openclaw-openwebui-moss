import type { WebUIClient } from '../api/webui-client.js';
import type { AttachmentsConfig } from '../types/config.js';
import type { OutboundAttachment, UploadedWebUIFile } from '../types/messages.js';
import type { Logger } from '../utils/logger.js';

export class OutboundAttachmentService {
  public constructor(
    private readonly client: WebUIClient,
    private readonly config: AttachmentsConfig,
    private readonly logger: Logger,
  ) {}

  public async uploadAll(
    attachments: readonly OutboundAttachment[],
  ): Promise<UploadedWebUIFile[]> {
    if (!this.config.enabled || attachments.length === 0) {
      return [];
    }

    const uploaded: UploadedWebUIFile[] = [];
    for (const attachment of attachments) {
      uploaded.push(
        await this.client.uploadAttachment(attachment.path, {
          ...(attachment.filename ? { filename: attachment.filename } : {}),
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          maxBytes: this.config.maxBytes,
        }),
      );
    }

    this.logger.info('Outbound attachments uploaded', {
      attachmentCount: uploaded.length,
    });

    return uploaded;
  }
}
