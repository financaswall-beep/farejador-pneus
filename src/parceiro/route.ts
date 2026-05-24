import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requirePartnerAuth, getPartnerContext, type PartnerAuthedRequest } from './auth.js';
import {
  cancelPartnerSale,
  cancelPartnerPayable,
  cancelPartnerReceivable,
  deletePartnerPurchase,
  deletePartnerStock,
  deletePartnerExpense,
  getPartnerCompras,
  getPartnerDespesas,
  getPartnerEstoque,
  getPartnerPayables,
  getPartnerProdutos,
  getPartnerReceivables,
  getPartnerResumo,
  getPartnerVendas,
  registerPartnerExpense,
  registerPartnerPayable,
  registerPartnerPurchase,
  registerPartnerReceivable,
  registerPartnerSale,
  settlePartnerPayable,
  settlePartnerReceivable,
  upsertPartnerStock,
} from './queries.js';

const publicDir = path.join(process.cwd(), 'parceiro', 'public');

const paramsSchema = z.object({
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/),
});

const expenseParamsSchema = paramsSchema.extend({
  expenseId: z.string().uuid(),
});

const saleParamsSchema = paramsSchema.extend({
  orderId: z.string().uuid(),
});

const stockParamsSchema = paramsSchema.extend({
  stockId: z.string().uuid(),
});

const purchaseParamsSchema = paramsSchema.extend({
  purchaseId: z.string().uuid(),
});

const payableParamsSchema = paramsSchema.extend({
  payableId: z.string().uuid(),
});

const receivableParamsSchema = paramsSchema.extend({
  receivableId: z.string().uuid(),
});

// Venda local do parceiro: cada item aponta direto pro estoque local do parceiro
// (partner_stock_levels.id), não pra commerce.products. Decisão "silo isolado" 2026-05-19.
const orderItemSchema = z.object({
  partner_stock_id: z.string().uuid(),
  quantity: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
  discount_amount: z.number().nonnegative().optional(),
});

const saleSchema = z.object({
  customer_name: z.string().min(1).max(200).nullable().optional(),
  customer_phone: z.string().min(1).max(40).nullable().optional(),
  items: z.array(orderItemSchema).min(1),
  payment_method: z.string().min(1).nullable(),
  payment_status: z.enum(['received', 'receivable']).nullable().optional(),
  receivable_due_date: z.string().date().nullable().optional(),
  fulfillment_mode: z.enum(['delivery', 'pickup']),
  delivery_address: z.string().min(1).nullable().optional(),
  source_tag: z.enum(['porta', '2w', 'walkin_balcao', 'walkin_telefone', 'outro']).optional(),
  idempotency_key: z.string().min(8),
}).refine(
  // S6 da auditoria 2026-05-21: pedido de entrega exige endereco.
  (data) => data.fulfillment_mode !== 'delivery' || (data.delivery_address && data.delivery_address.trim().length > 0),
  {
    message: 'delivery_address obrigatorio quando fulfillment_mode=delivery',
    path: ['delivery_address'],
  },
).refine(
  (data) => data.payment_status !== 'receivable' || (data.receivable_due_date && data.receivable_due_date.trim().length > 0),
  {
    message: 'receivable_due_date obrigatorio quando payment_status=receivable',
    path: ['receivable_due_date'],
  },
);

const stockSchema = z.object({
  stock_id: z.string().uuid().nullable().optional(),
  product_id: z.string().uuid().nullable().optional(),
  local_sku: z.string().max(80).nullable().optional(),
  item_name: z.string().min(1).max(240),
  tire_size: z.string().max(80).nullable().optional(),
  // Dimensões do pneu (migration 0038). Frontend captura os 3 separados,
  // banco persiste pra busca indexada (commerce.tire_specs ja segue esse padrão).
  tire_width_mm: z.number().int().min(1).max(999).nullable().optional(),
  tire_aspect_ratio: z.number().int().min(1).max(999).nullable().optional(),
  tire_rim_diameter: z.number().int().min(1).max(30).nullable().optional(),
  brand: z.string().max(120).nullable().optional(),
  supplier_name: z.string().max(160).nullable().optional(),
  quantity_on_hand: z.number().int().nonnegative().nullable().optional(),
  minimum_quantity: z.number().int().nonnegative().nullable().optional(),
  average_cost: z.number().nonnegative().nullable().optional(),
  sale_price: z.number().nonnegative().nullable().optional(),
  is_tracked: z.boolean().default(true),
});

const purchaseSchema = z.object({
  supplier_name: z.string().max(160).nullable().optional(),
  purchased_at: z.string().datetime().nullable().optional(),
  payment_method: z.string().max(80).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  idempotency_key: z.string().min(8).nullable().optional(),
  items: z.array(z.object({
    product_id: z.string().uuid().nullable().optional(),
    item_name: z.string().min(1).max(240),
    tire_size: z.string().max(80).nullable().optional(),
    tire_width_mm: z.number().int().min(1).max(999).nullable().optional(),
    tire_aspect_ratio: z.number().int().min(1).max(999).nullable().optional(),
    tire_rim_diameter: z.number().int().min(1).max(30).nullable().optional(),
    brand: z.string().max(120).nullable().optional(),
    quantity: z.number().int().positive(),
    unit_cost: z.number().nonnegative(),
    sale_price: z.number().nonnegative().nullable().optional(),
  })).min(1),
});

const expenseSchema = z.object({
  expense_date: z.string().date().nullable().optional(),
  category: z.enum(['employee_payment', 'rent', 'utilities', 'maintenance', 'delivery', 'tax', 'other']),
  description: z.string().min(1).max(300),
  amount: z.number().nonnegative(),
  payment_method: z.string().max(80).nullable().optional(),
  idempotency_key: z.string().min(8).nullable().optional(),
});

const payableSchema = z.object({
  counterparty_name: z.string().max(200).nullable().optional(),
  description: z.string().min(1).max(300),
  category: z.enum(['supplier', 'employee', 'rent', 'utilities', 'tax', 'maintenance', 'other']).nullable().optional(),
  amount: z.number().nonnegative(),
  due_date: z.string().date().nullable().optional(),
  status: z.enum(['open', 'paid']).nullable().optional(),
  paid_at: z.string().datetime().nullable().optional(),
  payment_method: z.string().max(80).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  idempotency_key: z.string().min(8).nullable().optional(),
});

const receivableSchema = z.object({
  customer_name: z.string().max(200).nullable().optional(),
  description: z.string().min(1).max(300),
  source_tag: z.enum(['porta', '2w', 'walkin_balcao', 'walkin_telefone', 'outro']).nullable().optional(),
  amount: z.number().nonnegative(),
  due_date: z.string().date().nullable().optional(),
  status: z.enum(['open', 'received']).nullable().optional(),
  received_at: z.string().datetime().nullable().optional(),
  payment_method: z.string().max(80).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  idempotency_key: z.string().min(8).nullable().optional(),
});

const settlePayableSchema = z.object({
  paid_at: z.string().datetime().nullable().optional(),
  payment_method: z.string().max(80).nullable().optional(),
});

const settleReceivableSchema = z.object({
  received_at: z.string().datetime().nullable().optional(),
  payment_method: z.string().max(80).nullable().optional(),
});

async function sendStatic(reply: FastifyReply, file: string, type: string) {
  const content = await readFile(path.join(publicDir, file));
  return reply
    .header('Content-Type', type)
    .header('Cache-Control', 'no-store')
    .send(content);
}

function validateSlug(request: PartnerAuthedRequest, reply: FastifyReply): boolean {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) {
    void reply.status(404).send({ error: 'partner_not_found' });
    return false;
  }
  return true;
}

export async function registerParceiroRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get('/parceiro/:slug', async (request: PartnerAuthedRequest, reply) => {
    if (!validateSlug(request, reply)) return;
    const slug = (request.params as { slug: string }).slug;
    return reply.redirect(`/parceiro/${slug}/`);
  });

  fastify.get('/parceiro/:slug/', async (request: PartnerAuthedRequest, reply) => {
    if (!validateSlug(request, reply)) return;
    return sendStatic(reply, 'index.html', 'text/html; charset=utf-8');
  });

  fastify.get('/parceiro/:slug/app.js', async (_request, reply) => sendStatic(reply, 'app.js', 'text/javascript; charset=utf-8'));
  fastify.get('/parceiro/:slug/style.css', async (_request, reply) => sendStatic(reply, 'style.css', 'text/css; charset=utf-8'));

  fastify.get('/parceiro/:slug/api/resumo', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: [await getPartnerResumo(getPartnerContext(request))].filter(Boolean) });
  });

  fastify.get('/parceiro/:slug/api/vendas', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerVendas(getPartnerContext(request)) });
  });

  fastify.get('/parceiro/:slug/api/estoque', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerEstoque(getPartnerContext(request)) });
  });

  fastify.get('/parceiro/:slug/api/produtos', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerProdutos(getPartnerContext(request)) });
  });

  // Endpoint /catalogo removido em 2026-05-19: parceiro é silo isolado, não consulta
  // commerce.products. Venda aponta direto pra partner_stock_levels.id.

  fastify.get('/parceiro/:slug/api/despesas', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerDespesas(getPartnerContext(request)) });
  });

  fastify.get('/parceiro/:slug/api/compras', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerCompras(getPartnerContext(request)) });
  });

  fastify.get('/parceiro/:slug/api/contas-a-pagar', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerPayables(getPartnerContext(request)) });
  });

  fastify.get('/parceiro/:slug/api/contas-a-receber', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerReceivables(getPartnerContext(request)) });
  });

  fastify.post('/parceiro/:slug/api/vendas', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = saleSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    try {
      return reply.status(200).send(await registerPartnerSale(getPartnerContext(request), parsed.data));
    } catch (err) {
      // BUG #2: erros de regra de negocio (estoque insuficiente, item inativado) viram
      // 422 com mensagem clara em vez de 500 internal_server_error.
      if (err instanceof Error && (
        err.message.includes('Estoque insuficiente') ||
        err.message.includes('Item de estoque') ||
        err.message.includes('quantity invalida') ||
        err.message.includes('unit_price invalido')
      )) {
        return reply.status(422).send({ error: err.message });
      }
      throw err;
    }
  });

  fastify.delete('/parceiro/:slug/api/vendas/:orderId', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = saleParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'order_not_found' });

    const result = await cancelPartnerSale(getPartnerContext(request), parsed.data.orderId);
    if (!result.cancelled) return reply.status(404).send({ error: 'order_not_found' });
    return reply.status(200).send(result);
  });

  fastify.post('/parceiro/:slug/api/estoque', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = stockSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    return reply.status(200).send(await upsertPartnerStock(getPartnerContext(request), parsed.data));
  });

  fastify.delete('/parceiro/:slug/api/estoque/:stockId', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = stockParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'stock_not_found' });

    const result = await deletePartnerStock(getPartnerContext(request), parsed.data.stockId);
    if (!result.deleted) return reply.status(404).send({ error: 'stock_not_found' });
    return reply.status(200).send(result);
  });

  fastify.post('/parceiro/:slug/api/compras', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = purchaseSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    return reply.status(200).send(await registerPartnerPurchase(getPartnerContext(request), parsed.data));
  });

  fastify.delete('/parceiro/:slug/api/compras/:purchaseId', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = purchaseParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'purchase_not_found' });

    const result = await deletePartnerPurchase(getPartnerContext(request), parsed.data.purchaseId);
    if (!result.deleted) return reply.status(404).send({ error: 'purchase_not_found' });
    return reply.status(200).send(result);
  });

  fastify.post('/parceiro/:slug/api/despesas', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = expenseSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    return reply.status(200).send(await registerPartnerExpense(getPartnerContext(request), parsed.data));
  });

  fastify.delete('/parceiro/:slug/api/despesas/:expenseId', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = expenseParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'expense_not_found' });

    const result = await deletePartnerExpense(getPartnerContext(request), parsed.data.expenseId);
    if (!result.deleted) return reply.status(404).send({ error: 'expense_not_found' });
    return reply.status(200).send(result);
  });

  fastify.post('/parceiro/:slug/api/contas-a-pagar', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = payableSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    return reply.status(200).send(await registerPartnerPayable(getPartnerContext(request), parsed.data));
  });

  fastify.post('/parceiro/:slug/api/contas-a-pagar/:payableId/pagar', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const params = payableParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'payable_not_found' });

    const parsed = settlePayableSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }

    const result = await settlePartnerPayable(getPartnerContext(request), params.data.payableId, parsed.data);
    if (!result.paid) return reply.status(404).send({ error: 'payable_not_found' });
    return reply.status(200).send(result);
  });

  fastify.delete('/parceiro/:slug/api/contas-a-pagar/:payableId', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = payableParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'payable_not_found' });

    const result = await cancelPartnerPayable(getPartnerContext(request), parsed.data.payableId);
    if (!result.cancelled) return reply.status(404).send({ error: 'payable_not_found' });
    return reply.status(200).send(result);
  });

  fastify.post('/parceiro/:slug/api/contas-a-receber', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = receivableSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    return reply.status(200).send(await registerPartnerReceivable(getPartnerContext(request), parsed.data));
  });

  fastify.post('/parceiro/:slug/api/contas-a-receber/:receivableId/receber', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const params = receivableParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'receivable_not_found' });

    const parsed = settleReceivableSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }

    const result = await settlePartnerReceivable(getPartnerContext(request), params.data.receivableId, parsed.data);
    if (!result.received) return reply.status(404).send({ error: 'receivable_not_found' });
    return reply.status(200).send(result);
  });

  fastify.delete('/parceiro/:slug/api/contas-a-receber/:receivableId', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = receivableParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'receivable_not_found' });

    const result = await cancelPartnerReceivable(getPartnerContext(request), parsed.data.receivableId);
    if (!result.cancelled) return reply.status(404).send({ error: 'receivable_not_found' });
    return reply.status(200).send(result);
  });
}
