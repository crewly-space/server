import type { Attachment } from '../../protocol/index.js';
import type { HttpClient } from '../http-client.js';
import { encodePathSegment } from '../path.js';

export interface UploadAttachmentInput {
  conversationId: string;
  filename: string;
  mimeType: string;
  dataBase64: string;
}

export class AttachmentsResource {
  constructor(private readonly http: HttpClient) {}

  upload(input: UploadAttachmentInput): Promise<Attachment> {
    return this.http.request('POST', '/api/v1/attachments', input);
  }

  download(id: string): Promise<Blob> {
    return this.http.requestBlob(`/api/v1/attachments/${encodePathSegment(id)}`);
  }

  remove(id: string): Promise<void> {
    return this.http.request('DELETE', `/api/v1/attachments/${encodePathSegment(id)}`);
  }
}
