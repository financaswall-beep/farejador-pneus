import { z } from 'zod';

const selections = z.array(z.object({
  candidate_id: z.string().uuid(),
  quantity: z.number().int().positive().max(1_000_000),
}).strict()).min(1).refine(rows => new Set(rows.map(row => row.candidate_id)).size === rows.length);

export const stockOriginConfirmationSchema = z.object({
  pending_id: z.string().uuid(),
  selections,
  idempotency_key: z.string().uuid(),
}).strict();
export const stockOriginConfirmationBody = stockOriginConfirmationSchema.omit({ pending_id: true });
