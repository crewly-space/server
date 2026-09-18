import { z } from 'zod';

export const ActorTypeSchema = z.enum(['user', 'agent']);
export type ActorType = z.infer<typeof ActorTypeSchema>;
