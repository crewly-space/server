import { z } from 'zod';

export const ActorTypeSchema = z.enum(['user', 'agent', 'integration']);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const ParticipantTypeSchema = z.enum(['user', 'agent']);
export type ParticipantType = z.infer<typeof ParticipantTypeSchema>;

/** How a person or agent is drawn. The avatar itself is generated on each device. */
export const AvatarModeSchema = z.enum(['bloop', 'blobatar', 'name']);
export type AvatarMode = z.infer<typeof AvatarModeSchema>;
