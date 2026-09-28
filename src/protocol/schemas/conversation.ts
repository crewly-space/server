import { z } from 'zod';
import { ParticipantTypeSchema } from './common.js';

export const ConversationKindSchema = z.enum(['dm', 'group', 'channel']);
export type ConversationKind = z.infer<typeof ConversationKindSchema>;

export const ParticipantRefSchema = z.object({
  participantId: z.string().min(1),
  participantType: ParticipantTypeSchema,
});
export type ParticipantRef = z.infer<typeof ParticipantRefSchema>;

export const ConversationSchema = z
  .object({
    id: z.string().min(1),
    kind: ConversationKindSchema,
    name: z.string().min(1).nullable(),
    // A channel can be empty or have one member; a DM or group cannot.
    participants: z.array(ParticipantRefSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .refine((c) => c.kind === 'dm' || c.name !== null, {
    message: 'group conversations and channels require a name',
    path: ['name'],
  })
  .refine((c) => c.kind === 'channel' || c.participants.length >= 2, {
    message: 'dm and group conversations require at least two participants',
    path: ['participants'],
  })
  .refine((c) => c.kind !== 'dm' || c.participants.length === 2, {
    message: 'dm conversations require exactly two participants',
    path: ['participants'],
  });
export type Conversation = z.infer<typeof ConversationSchema>;

/**
 * Who answers a message that addresses nobody in particular.
 * - `mentions`: @, names, replies and follow-ups, plus the one agent whose
 *   role plainly matches the topic (keywords). Cheap and predictable.
 * - `model`: a small model call reads the message and picks who answers.
 * - `open`: every agent hears it and decides for itself whether to reply;
 *   an agent busy with other work is left to it.
 */
export const ConversationReplyModeSchema = z.enum(['mentions', 'model', 'open']);
export type ConversationReplyMode = z.infer<typeof ConversationReplyModeSchema>;

export const ConversationReplySettingsSchema = z.object({
  replyMode: ConversationReplyModeSchema,
});
export type ConversationReplySettings = z.infer<typeof ConversationReplySettingsSchema>;
