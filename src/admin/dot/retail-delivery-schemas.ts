import { z } from 'zod';
import { registerWalkinOrderSchema } from '../painel/route-schemas-orders.js';
import { hasCentPrecision } from '../painel/sales-money.js';

const walkin = registerWalkinOrderSchema.innerType().innerType().shape;
export const id = z.string().uuid();
const amount = z.number().positive().max(99_999_999.99).refine(hasCentPrecision);
const instant = z.string().datetime({offset:true});
const method = z.enum(['pix','dinheiro','cartao','debito','credito','transferencia']);
const account = z.string().trim().min(2).max(80);
const tender = z.object({amount,payment_method:method,cash_account:account}).strict();
export const saleSchema = z.object({
  idempotency_key:id, sold_at:instant, delivered_at:instant.optional(),
  delivery_address:z.string().trim().min(2).max(500).optional(),
  customer_mode:z.enum(['existing','new','anonymous']), customer_ref:walkin.customer_ref,
  customer_name:walkin.customer_name, customer_phone:walkin.customer_phone,
  items:walkin.items, freight:z.number().nonnegative().max(99_999_999.99).refine(hasCentPrecision),
  vendas_distintas_de:z.array(id).max(20).optional(),
  payments:z.array(tender).min(1).max(8),
}).strict();
export const expenseSchema = z.union([
  z.object({expense_id:id}).strict(),
  z.object({category:z.string().trim().min(2).max(80),description:z.string().trim().min(2).max(500),
    amount,occurred_at:instant,payment_method:method,cash_account:account}).strict(),
]);
export const tripSchema = z.object({
  idempotency_key:id, courier_name:z.string().trim().min(2).max(150),
  destination:z.string().trim().min(2).max(500), started_at:instant,ended_at:instant,
  deliveries:z.array(z.object({order_id:id,delivered_at:instant}).strict()).min(1).max(100),
  expenses:z.array(expenseSchema).max(80),
}).strict();
export type Sale = z.infer<typeof saleSchema>;
export type Trip = z.infer<typeof tripSchema>;
export function assertHistorical(instant:string) {
  if (Date.parse(instant)>Date.now()) throw Error('horario_real_no_futuro');
}
