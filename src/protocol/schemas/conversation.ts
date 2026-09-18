import { z } from 'zod';
import { ActorTypeSchema } from './common.js';

export const ConversationKindSchema = z.enum(['dm', 'group']);
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
    participants: z.array(ParticipantRefSchema).min(2),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .refine((c) => c.kind !== 'group' || c.name !== null, {
    message: 'group conversations require a name',
    path: ['name'],
  })
  .refine((c) => c.kind !== 'dm' || c.participants.length === 2, {
    message: 'dm conversations require exactly two participants',
    path: ['participants'],
  });
export type Conversation = z.infer<typeof ConversationSchema>;
