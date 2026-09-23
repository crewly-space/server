import { z } from 'zod';

export const ActorTypeSchema = z.enum(['user', 'agent']);
export type ActorType = z.infer<typeof ActorTypeSchema>;

/** How a person or agent is drawn. The avatar itself is generated on each device. */
export const AvatarModeSchema = z.enum(['bloop', 'blobatar', 'name']);
export type AvatarMode = z.infer<typeof AvatarModeSchema>;
