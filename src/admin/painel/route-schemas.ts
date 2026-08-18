// Obra 300 (2026-07-05): mezanino da portaria da matriz — schemas zod + publicDir.
// VERBATIM das linhas 76-325 do route.ts pré-obra + prefixo 'export ' nas declarações
// de topo (transformação mecânica; o gerador prova a reversa). Porta: ./route.js.
import path from 'node:path';
import { z } from 'zod';
import { assertWholesaleSaleMoney } from './sales-money.js';

const idempotencyKeySchema = z.string().min(8).max(200);
const tireConditionSchema = z.enum(['meia_vida', 'novo', 'remold']);

function saoPauloDate(instant: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function isNotFutureSaoPauloDate(instant: string): boolean {
  return saoPauloDate(instant) <= saoPauloDate(new Date().toISOString());
}

export const resolveIntegrityOperationSchema = z.object({
  domain: z.enum([
    'wholesale_sale.create',
    'wholesale_purchase.create',
    'matriz_expense.create',
    'stock.entry',
    'stock.manual_decrement',
    'stock.physical_count',
    'stock.condition_transfer',
  ]),
  idempotency_key: idempotencyKeySchema,
});

export const publicDir = path.join(process.cwd(), 'painel', 'public');

export const limitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const redeQuerySchema = z.object({
  period: z.enum(['today', '7d', '30d', 'month']).default('month'),
});

export const resumoQuerySchema = z.object({
  period: z.enum(['today', '7d', '30d', 'month']).default('7d'),
});

// Recorte dos resumos de venda. Financeiro usa mês; Vendas usa hoje/7d/30d.
export const financePeriodQuerySchema = z.object({
  period: z.enum(['today', '7d', '30d', 'mes', 'tudo']).default('tudo'),
});

// Comissões da Rede (0118): quitar por parceiro + editor do modelo comercial.
export {
  partnerIdParamSchema, partnerTermsSchema, settleComissaoSchema,
  settleCommissionRefundSchema, settleMonthlyFeeSchema,
} from './route-schemas-comissoes.js';

// Onboarding de parceiro (Etapa 1). Termos comerciais são definidos pela matriz aqui,
// não pelo candidato. municipios = cobertura inicial; slug opcional (gerado do nome).
export const createPartnerSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  trade_name: z.string().min(2),
  legal_name: z.string().min(1).nullable().optional(),
  document_number: z.string().min(1).nullable().optional(),
  responsible_name: z.string().min(1).nullable().optional(),
  whatsapp_phone: z.string().min(1).nullable().optional(),
  email: z.string().email().nullable().optional(),
  address: z.string().min(1).nullable().optional(),
  commercial_model: z.string().min(1).nullable().optional(),
  commission_percent: z.number().min(0).max(100).nullable().optional(),
  monthly_fee: z.number().min(0).nullable().optional(),
  municipios: z.array(z.string().min(1)).default([]),
  slug: z.string().min(1).nullable().optional(),
});

// Raio de entrega que a MATRIZ define pra um parceiro (proximidade-primeiro Fase 2).
// km livre > 0, ≤ 9999,99 (NUMERIC(6,2)); null = limpar (parceiro sai da entrega).
export const setDeliveryRadiusParamsSchema = z.object({
  partnerUnitId: z.string().uuid(),
});
export const setDeliveryRadiusBodySchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  delivery_radius_km: z.number().positive().max(9999.99).nullable(),
});

// 0165 — "Recebe pedidos da Rede?": a Matriz liga/desliga a participação da loja
// no roteamento do bot. Reusa o params schema do raio (mesma :partnerUnitId).
// Sem `environment` no corpo DE PROPÓSITO: quem manda é o servidor (chave de
// contrato comercial não se escolhe ambiente pelo navegador).
export const setNetworkOrdersBodySchema = z.object({
  accepts_network_orders: z.boolean(),
});

// ATACADO (Fase 1): venda de atacado da Matriz. Comprador = ficha existente
// (customer_id), parceiro da rede (partner_id) OU só-atacado novo (new_customer).
// Preço DIGITADO por item. Admin-only (dado só da matriz).
export const wholesaleItemSchema = z.object({
  measure: z.string().min(1).max(60),
  brand: z.string().trim().min(1, 'brand_required').max(60),
  tire_condition: tireConditionSchema,
  quantity: z.number().int().positive().max(100000),
  unit_price: z.number().min(0).max(9999999.99),
});
const wholesaleItemsSchema = z.array(wholesaleItemSchema).min(1, 'items_required').max(50, 'sale_items_limit')
  .superRefine((items, ctx) => {
    try {
      assertWholesaleSaleMoney(items);
    } catch (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
    }
  });
export const registerWholesaleSaleSchema = z
  .object({
    customer_id: z.string().uuid().nullable().optional(),
    partner_id: z.string().uuid().nullable().optional(),
    new_customer: z
      .object({ name: z.string().min(1).max(200), phone: z.string().max(40).nullable().optional() })
      .nullable()
      .optional(),
    parent_order_id: z.string().uuid().nullable().optional(),
    partner_unit_id: z.string().uuid().nullable().optional(),
    items: wholesaleItemsSchema,
    sold_at: z.string().datetime({ offset: true }).nullable().optional(),
    paid_at: z.string().datetime({ offset: true }).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
    idempotency_key: idempotencyKeySchema,
    // FINANCEIRO (0115): 'pending' = fiado (a receber), com vencimento obrigatório.
    // Ignorados com WHOLESALE_FINANCE off (a venda nasce 'paid', como hoje).
    payment_status: z.enum(['paid', 'pending']).optional(),
    due_date: z.string().date().nullable().optional(),
  })
  .refine(
    (d) => Boolean(d.parent_order_id)
      || !!d.customer_id || !!d.partner_id || !!(d.new_customer && d.new_customer.name.trim()),
    { message: 'buyer_required' },
  )
  .refine(
    (d) => Boolean(d.parent_order_id)
      ? [d.customer_id, d.partner_id, d.new_customer?.name?.trim()].filter(Boolean).length === 0
      : [d.customer_id, d.partner_id, d.new_customer?.name?.trim()].filter(Boolean).length === 1,
    { message: 'buyer_ambiguous' },
  )
  .refine(
    (d) => d.payment_status !== 'pending' || Boolean(d.due_date),
    { message: 'due_date_required', path: ['due_date'] },
  )
  .refine(
    (d) => !d.sold_at || isNotFutureSaoPauloDate(d.sold_at),
    { message: 'sold_at_future', path: ['sold_at'] },
  )
  .refine(
    (d) => !d.paid_at || isNotFutureSaoPauloDate(d.paid_at),
    { message: 'paid_at_future', path: ['paid_at'] },
  )
  .refine(
    (d) => !d.sold_at || !d.paid_at || new Date(d.paid_at).getTime() >= new Date(d.sold_at).getTime(),
    { message: 'paid_at_before_sale', path: ['paid_at'] },
  )
  .refine(
    (d) => !d.sold_at || !d.due_date
      || d.due_date >= saoPauloDate(d.sold_at),
    { message: 'due_date_before_sale', path: ['due_date'] },
  );

// ATACADO (Fase 2): estoque do galpão por MEDIDA (gestão + autocomplete). Admin-only.

export * from './route-schemas-purchases.js';

// FINANCEIRO do atacado (0115): quitar um fiado — venda (a receber) ou compra (a pagar).
export const settleWholesaleFinanceSchema = z.object({
  kind: z.enum(['sale', 'purchase']),
  id: z.string().uuid(),
  paid_at: z.string().datetime({ offset: true }).optional(),
  payment_method: z.string().trim().min(2).max(40).nullable().optional(),
  cash_account: z.string().trim().min(2).max(80).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  idempotency_key: idempotencyKeySchema,
}).refine(
  (d) => !d.paid_at || isNotFutureSaoPauloDate(d.paid_at),
  { message: 'paid_at_future', path: ['paid_at'] },
);

// DESPESAS da matriz (0120): lançar (à vista × a pagar), quitar e remover (soft).
export const createMatrizExpenseSchema = z.object({
  // 0130: modalidade virou lista viva — o formato valida aqui; existir E estar
  // ativa valida no banco (guard + FK). z.enum fixo barraria as do dono.
  category: z.string().regex(/^[a-z0-9_]{2,40}$/),
  description: z.string().max(300).nullable().optional(),
  amount: z.number().positive(),
  payment_status: z.enum(['paid', 'pending']).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  paid_at: z.string().datetime({ offset: true }).nullable().optional(),
  occurred_at: z.string().datetime({ offset: true }).nullable().optional(),
  document_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  competence_month: z.string().regex(/^\d{4}-\d{2}-01$/).nullable().optional(),
  idempotency_key: idempotencyKeySchema,
}).superRefine((body, ctx) => {
  if (body.payment_status === 'pending' && !body.due_date) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['due_date'], message: 'due_date_required' });
  }
});

export const matrizExpenseIdSchema = z.object({
  id: z.string().uuid(),
  paid_at: z.string().datetime({ offset: true }).optional(),
  payment_method: z.string().trim().min(2).max(40).nullable().optional(),
  cash_account: z.string().trim().min(2).max(80).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  idempotency_key: idempotencyKeySchema,
});

export const matrizExpenseRemoveSchema = matrizExpenseIdSchema.extend({
  reason: z.string().trim().min(2).max(300),
});

// 0130: modalidades de despesa cadastráveis + filtro de período da lista.
export const matrizExpenseCategoryCreateSchema = z.object({
  label: z.string().trim().min(2).max(40),
});
export const matrizExpenseCategoryArchiveSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_]{2,40}$/),
});
export const matrizExpensesQuerySchema = z.object({
  mes: z.string().regex(/^\d{4}-\d{2}$/).optional(),       // competência (occurred_at, fuso SP)
  categoria: z.string().regex(/^[a-z0-9_]{2,40}$/).optional(),
});

// Cancelar venda: sai do ranking/resumo/fiado, devolve a baixa comprovada e
// exige motivo para a trilha.
export const cancelWholesaleSaleSchema = z.object({
  order_id: z.string().uuid(),
  reason: z.string().trim().min(2).max(300),
  idempotency_key: idempotencyKeySchema,
});

// Etapa 3: candidatura pública "quero ser parceiro". 'website' é honeypot anti-spam.
export const partnerApplicationSchema = z.object({
  trade_name: z.string().trim().min(2).max(160),
  responsible_name: z.string().trim().min(1).max(160).nullable().optional(),
  whatsapp_phone: z.string().trim().min(1).max(40).nullable().optional(),
  // E-mail é opcional e sem validação de formato: o canal real é o WhatsApp.
  // Vazio vira null pra não derrubar o envio.
  email: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().max(160).nullable().optional(),
  ),
  address: z.string().trim().min(1).max(500).nullable().optional(),
  municipios: z.string().trim().min(1).max(500).nullable().optional(),
  message: z.string().max(1000).nullable().optional(),
  website: z.string().max(500).optional(),
});

export const applicationsQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
});

// Aprovação: termos comerciais e cobertura REAL são definidos pelo dono aqui.
export const approveApplicationSchema = z.object({
  idempotency_key: idempotencyKeySchema,
  municipios: z.array(z.string().min(1)).min(1),
  commission_percent: z.number().min(0).max(100).nullable().optional(),
  monthly_fee: z.number().min(0).nullable().optional(),
  commercial_model: z.string().min(1).nullable().optional(),
  slug: z.string().min(1).nullable().optional(),
});

export * from './route-schemas-orders.js';
export * from './route-schemas-stock.js';
