import { z } from 'zod';
import { businessDateSaoPaulo } from '../../shared/business-time.js';

export const simpleFinanceQuerySchema = z.object({
  range: z.enum(['today', '7d', '15d', '30d']).default('30d'),
  period: z.string().regex(/^(?:20|21)\d{2}-(0[1-9]|1[0-2])$/)
    .refine(value => value <= businessDateSaoPaulo(new Date()).slice(0, 7), 'future_month')
    .optional(),
});
