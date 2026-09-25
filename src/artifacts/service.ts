import type { Agent } from '../protocol/index.js';
import type { Database } from '../db/driver.js';
import {
  AttachmentValidationError,
  AttachmentStore,
  createAttachment,
  decodeBase64,
  attachmentViewWithArtifact,
  type AttachmentView,
} from '../attachments/service.js';
import type { AgentToolset, ToolOutcome, ToolsetProvider } from '../providers/respond.js';
import type { RespondInput } from '../runtime/engine.js';

export const CREATE_ARTIFACT_TOOL = 'create_artifact';

export function createArtifact(
  db: Database,
  store: AttachmentStore,
  input: {
    conversationId: string;
    uploadedBy: string;
    agentId: string;
    runId: string;
    filename: string;
    mimeType: string;
    data: Buffer;
  },
): AttachmentView {
  const attachment = createAttachment(db, store, input);
  try {
    db.prepare(
      `INSERT INTO artifacts (attachment_id, run_id, agent_id, conversation_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(attachment.id, input.runId, input.agentId, input.conversationId, new Date().toISOString());
  } catch (error) {
    db.prepare('DELETE FROM attachments WHERE id = ?').run(attachment.id);
    store.remove(`${attachment.id}.bin`);
    throw error;
  }
  return attachmentViewWithArtifact(db, attachment.id)!;
}

export interface ArtifactToolsetOptions {
  db: Database;
  store: AttachmentStore;
}

/** Lets a model deliberately publish bytes; ordinary text or tool output never becomes an artifact. */
export function artifactToolset(options: ArtifactToolsetOptions): ToolsetProvider {
  return (agent: Agent, input: RespondInput): AgentToolset | undefined => {
    if (!input.run || input.allowArtifacts === false) return undefined;
    const runId = input.run.runId;
    return {
      definitions: [{
        name: CREATE_ARTIFACT_TOOL,
        description: 'Publish a generated file into this conversation. Use only when the user explicitly asked for a file, report, or other durable asset.',
        inputSchema: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'The file name users should see.' },
            mimeType: { type: 'string', description: 'The exact MIME type, such as application/pdf or text/plain.' },
            dataBase64: { type: 'string', description: 'The complete file contents encoded as base64.' },
          },
          required: ['filename', 'mimeType', 'dataBase64'],
        },
      }],
      instructions: 'Only call create_artifact for an intentional durable file output. Do not use it for ordinary answers, logs, or arbitrary tool stdout.',
      async execute(call): Promise<ToolOutcome> {
        const filename = String(call.input.filename ?? '').trim();
        const mimeType = String(call.input.mimeType ?? '').trim();
        const encoded = String(call.input.dataBase64 ?? '');
        if (!filename || !mimeType || !encoded) return { content: 'filename, mimeType, and dataBase64 are required.', isError: true };
        try {
          const artifact = createArtifact(options.db, options.store, {
            conversationId: input.conversationId,
            uploadedBy: agent.ownerUserId,
            agentId: agent.id,
            runId,
            filename,
            mimeType,
            data: decodeBase64(encoded),
          });
          return {
            artifactId: artifact.id,
            content: JSON.stringify({ status: 'created', artifactId: artifact.id, filename: artifact.filename, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes }),
          };
        } catch (error) {
          const message = error instanceof AttachmentValidationError ? error.message : 'artifact creation failed';
          return { content: message, isError: true };
        }
      },
    };
  };
}
