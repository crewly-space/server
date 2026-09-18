import { z } from 'zod';

export const WsServerEventSchema = z.object({
  seq: z.number().int().min(1),
  topic: z.string().min(1),
  type: z.string().min(1),
  ts: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
});
export type WsServerEvent = z.infer<typeof WsServerEventSchema>;

export const WsResumeRequestSchema = z.object({
  op: z.literal('resume'),
  sinceSeq: z.number().int().min(0),
});
export type WsResumeRequest = z.infer<typeof WsResumeRequestSchema>;
