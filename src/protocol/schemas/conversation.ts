import { z } from 'zod';
import { ActorTypeSchema } from './common.js';

export const ConversationKindSchema = z.enum(['dm', 'group', 'channel']);
export type ConversationKind = z.infer<typeof ConversationKindSchema>;

export const ParticipantRefSchema = z.object({
  participantId: z.string().min(1),
  participantType: ActorTypeSchema,
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
