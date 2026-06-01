import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requirePartnerAuth, getPartnerContext, authenticatePartnerToken, type PartnerAuthedRequest } from './auth.js';
import {
  cancelPartnerSale,
  cancelPartnerPayable,
  cancelPartnerReceivable,
  DeliveryAlreadyFinalizedError,
  deletePartnerPurchase,
  deletePartnerStock,
  deletePartnerExpense,
  createPartnerCustomer,
  DuplicateExpenseError,
  InstallmentsNotAllowedError,
  InstallmentsTooSmallError,
  PaidPurchaseLockedError,
  PartialStockReversalError,
  StockBelowReservedError,
  StockReservedCannotDeleteError,
  getPartnerChatConversations,
  getPartnerChatMessages,
  getPartnerChatCustomer,
  sendPartnerChatMessage,
  markPartnerChatRead,
  getPartnerCompras,
  getPartnerCustomers,
  getPartnerDespesas,
  getPartnerEstoque,
  getPartnerPayables,
  getPartnerProdutos,
  getPartnerReceivables,
  searchPartnerCustomers,
  getPartnerFluxoCaixa,
  getPartnerResumo,
  getPartnerVendas,
  registerPartnerExpense,
  registerPartnerPayable,
  registerPartnerPurchase,
  registerPartnerReceivable,
  registerPartnerSale,
  settlePartnerPayable,
  settlePartnerReceivable,
  settlePartnerReceivableInstallment,
  updatePartnerCustomer,
  deletePartnerCustomer,
  updatePartnerPayable,
  updatePartnerReceivable,
  updatePartnerDeliveryStatus,
  upsertPartnerStock,
} from './queries.js';
import { subscribePartnerChat, type PartnerChatEvent } from '../normalization/partner-chat.notify.js';

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

const deliverySchema = z.object({
  delivery_status: z.enum(['pending', 'dispatched', 'delivered', 'failed']),
  delivery_courier: z.string().max(120).nullable().optional(),
  // Metodo recebido na entrega (COD). So tem efeito quando delivery_status='delivered'.
  payment_method: z.string().max(80).nullable().optional(),
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

const receivableInstallmentParamsSchema = paramsSchema.extend({
  receivableId: z.string().uuid(),
  installmentId: z.string().uuid(),
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
  customer_id: z.string().uuid().nullable().optional(),
  customer_name: z.string().min(1).max(200).nullable().optional(),
  customer_phone: z.string().min(1).max(40).nullable().optional(),
  customer_cpf: z.string().min(11).max(14).nullable().optional(),
  items: z.array(orderItemSchema).min(1),
  payment_method: z.string().min(1).nullable(),
  payment_status: z.enum(['received', 'receivable']).nullable().optional(),
  receivable_due_date: z.string().date().nullable().optional(),
  receivable_installments: z.number().int().min(1).max(36).nullable().optional(),
  fulfillment_mode: z.enum(['delivery', 'pickup']),
  delivery_address: z.string().min(1).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  received_amount: z.number().nonnegative().nullable().optional(),
  discount_amount: z.number().nonnegative().nullable().optional(),
  freight_amount: z.number().nonnegative().nullable().optional(),
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
  // COD (0069): pedido de entrega "a receber" nao tem vencimento — o dinheiro vem
  // na hora da entrega. So exige due_date pra "a receber" de retirada (pickup).
  (data) => data.payment_status !== 'receivable'
    || data.fulfillment_mode === 'delivery'
    || (data.receivable_due_date && data.receivable_due_date.trim().length > 0),
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
  // Tipo do item (migration 0067): pneu | insumo (camara, bico) | servico (mao de obra).
  item_type: z.enum(['pneu', 'insumo', 'servico']).default('pneu'),
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
  // Campos do refit da tela de estoque (migration 0073).
  tire_condition: z.string().max(40).nullable().optional(),
  shelf_location: z.string().max(60).nullable().optional(),
  // Posição do pneu em coluna própria (migration 0075) — antes vivia em supplier_name.
  tire_position: z.string().max(40).nullable().optional(),
  is_tracked: z.boolean().default(true),
});

const customerSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(1).max(40).nullable().optional(),
  cpf: z.string().min(11).max(14).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  address_street: z.string().max(240).nullable().optional(),
  address_number: z.string().max(40).nullable().optional(),
  address_neighborhood: z.string().max(160).nullable().optional(),
  address_city: z.string().max(160).nullable().optional(),
  is_vip: z.boolean().nullable().optional(),
  idempotency_key: z.string().min(8).nullable().optional(),
});

const customerSearchSchema = z.object({
  q: z.string().min(1).max(120),
});

const customerIdParamsSchema = paramsSchema.extend({
  customerId: z.string().uuid(),
});

const chatConversationParamsSchema = paramsSchema.extend({
  conversationId: z.string().uuid(),
});

const chatSendBodySchema = z.object({
  content: z.string().trim().min(1).max(4096),
  client_token: z.string().trim().min(1).max(128),
});

const purchaseSchema = z.object({
  supplier_name: z.string().max(160).nullable().optional(),
  purchased_at: z.string().datetime().nullable().optional(),
  payment_method: z.string().max(80).nullable().optional(),
  payment_status: z.enum(['paid_now', 'payable']).nullable().optional(),
  payable_due_date: z.string().date().nullable().optional(),
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
}).refine(
  (data) => data.payment_status !== 'payable' || (data.payable_due_date && data.payable_due_date.trim().length > 0),
  {
    message: 'payable_due_date obrigatorio quando payment_status=payable',
    path: ['payable_due_date'],
  },
);

const expenseSchema = z.object({
  expense_date: z.string().date().nullable().optional(),
  category: z.enum(['employee_payment', 'rent', 'utilities', 'maintenance', 'delivery', 'tax', 'supplier_payment', 'other']),
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
  force_duplicate: z.boolean().optional(),
});

const payableUpdateSchema = payableSchema
  .omit({
    status: true,
    paid_at: true,
    payment_method: true,
    idempotency_key: true,
    force_duplicate: true,
  })
  .refine((data) => !!data.due_date, {
    message: 'due_date obrigatorio para conta a pagar em aberto',
    path: ['due_date'],
  });

const receivableSchema = z.object({
  customer_id: z.string().uuid().nullable().optional(),
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

const receivableUpdateSchema = receivableSchema
  .omit({
    status: true,
    received_at: true,
    payment_method: true,
    idempotency_key: true,
  })
  .refine((data) => !!data.due_date, {
    message: 'due_date obrigatorio para conta a receber em aberto',
    path: ['due_date'],
  });

const settlePayableSchema = z.object({
  paid_at: z.string().datetime().nullable().optional(),
  payment_method: z.string().max(80).nullable().optional(),
  force_duplicate: z.boolean().optional(),
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

  // Assets estáticos (logo, ícones de canal do chat, fundo). Genérico + seguro:
  // basename evita path traversal; só extensões de imagem conhecidas são servidas.
  const assetContentTypes: Record<string, string> = {
    '.svg': 'image/svg+xml; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  };
  fastify.get('/parceiro/:slug/assets/:asset', async (request: PartnerAuthedRequest, reply) => {
    const asset = path.basename(String((request.params as { asset?: string }).asset || ''));
    const type = assetContentTypes[path.extname(asset).toLowerCase()];
    if (!type) return reply.status(404).send({ error: 'asset_not_found' });
    try {
      return await sendStatic(reply, path.join('assets', asset), type);
    } catch {
      return reply.status(404).send({ error: 'asset_not_found' });
    }
  });

  fastify.get('/parceiro/:slug/api/resumo', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: [await getPartnerResumo(getPartnerContext(request))].filter(Boolean) });
  });

  fastify.get('/parceiro/:slug/api/fluxo-caixa', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: [await getPartnerFluxoCaixa(getPartnerContext(request))].filter(Boolean) });
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

  fastify.get('/parceiro/:slug/api/clientes', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerCustomers(getPartnerContext(request)) });
  });

  fastify.get('/parceiro/:slug/api/clientes/buscar', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = customerSearchSchema.safeParse(request.query);
    if (!parsed.success) return reply.status(200).send({ rows: [] });
    return reply.status(200).send({ rows: await searchPartnerCustomers(getPartnerContext(request), parsed.data.q) });
  });

  fastify.post('/parceiro/:slug/api/clientes', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = customerSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    return reply.status(200).send(await createPartnerCustomer(getPartnerContext(request), parsed.data));
  });

  fastify.put('/parceiro/:slug/api/clientes/:customerId', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const params = customerIdParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_customer_id' });
    const parsed = customerSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    try {
      return reply.status(200).send(await updatePartnerCustomer(getPartnerContext(request), params.data.customerId, parsed.data));
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === 'customer_not_found') return reply.status(404).send({ error: 'customer_not_found' });
        if (err.message === 'customer_phone_conflict') return reply.status(409).send({ error: 'customer_phone_conflict' });
        if (err.message === 'customer_cpf_conflict') return reply.status(409).send({ error: 'customer_cpf_conflict' });
        if (err.message === 'customer_name_required') return reply.status(400).send({ error: 'customer_name_required' });
      }
      throw err;
    }
  });

  fastify.delete('/parceiro/:slug/api/clientes/:customerId', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const params = customerIdParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_customer_id' });
    try {
      return reply.status(200).send(await deletePartnerCustomer(getPartnerContext(request), params.data.customerId));
    } catch (err) {
      if (err instanceof Error && err.message === 'customer_not_found') {
        return reply.status(404).send({ error: 'customer_not_found' });
      }
      throw err;
    }
  });

  // Chat unificado (Fatia 1.3) — leitura. Conversas e mensagens espelhadas
  // pelo fan-out do Chatwoot. Só leitura; o envio (POST) é Fatia 2.
  fastify.get('/parceiro/:slug/api/chat/conversations', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send({ rows: await getPartnerChatConversations(getPartnerContext(request)) });
  });

  fastify.get('/parceiro/:slug/api/chat/conversations/:conversationId/messages', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const params = chatConversationParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'conversation_not_found' });

    const rows = await getPartnerChatMessages(getPartnerContext(request), params.data.conversationId);
    if (rows === null) return reply.status(404).send({ error: 'conversation_not_found' });
    return reply.status(200).send({ rows });
  });

  // Fase 2a — cliente vinculado à conversa (por telefone) + métricas de compra.
  // Read-only. 404 se a conversa não existe/não é da unidade.
  fastify.get('/parceiro/:slug/api/chat/conversations/:conversationId/customer', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const params = chatConversationParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'conversation_not_found' });

    const data = await getPartnerChatCustomer(getPartnerContext(request), params.data.conversationId);
    if (data === null) return reply.status(404).send({ error: 'conversation_not_found' });
    return reply.status(200).send(data);
  });

  // Fatia 2 — envio. O parceiro responde o cliente; grava otimista + manda pro
  // Chatwoot (echo_id = client_token); o eco do webhook preenche o id depois.
  fastify.post('/parceiro/:slug/api/chat/conversations/:conversationId/send', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const params = chatConversationParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'conversation_not_found' });

    const body = chatSendBodySchema.safeParse(request.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      return reply.status(400).send({ error: `${issue?.path.join('.')}: ${issue?.message ?? 'invalid'}` });
    }

    const result = await sendPartnerChatMessage(
      getPartnerContext(request),
      params.data.conversationId,
      body.data.content,
      body.data.client_token,
    );
    if (result.status === 'not_found') return reply.status(404).send({ error: 'conversation_not_found' });
    if (result.status === 'send_failed') return reply.status(502).send({ error: 'send_failed' });
    return reply.status(200).send({ message: result.message });
  });

  // Marca a conversa como lida (zera unread_count) quando o parceiro a abre.
  fastify.post('/parceiro/:slug/api/chat/conversations/:conversationId/read', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const params = chatConversationParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'conversation_not_found' });

    const ok = await markPartnerChatRead(getPartnerContext(request), params.data.conversationId);
    if (!ok) return reply.status(404).send({ error: 'conversation_not_found' });
    return reply.status(200).send({ ok: true });
  });

  // Tempo real (Fatia 3): SSE que empurra um evento quando chega mensagem nova,
  // pra UI atualizar na hora sem depender do polling. EventSource NAO manda
  // header Authorization — por isso o token vem por query string e e validado
  // aqui do mesmo jeito (mesma function SECURITY DEFINER). O front cai no
  // polling se o SSE nao conectar.
  fastify.get('/parceiro/:slug/api/chat/stream', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const { token } = request.query as { token?: string };
    if (!slug || !token) return reply.code(401).send({ error: 'partner_unauthorized' });
    const ctx = await authenticatePartnerToken(slug.trim(), token);
    if (!ctx) return reply.code(401).send({ error: 'partner_unauthorized' });

    // Assume o controle da resposta crua (stream que nao fecha).
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // desliga buffering de proxy (nginx)
    });
    raw.write('retry: 3000\n\n');
    raw.write(': conectado\n\n');

    const send = (event: PartnerChatEvent): void => {
      raw.write(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = subscribePartnerChat(ctx.unitId, send);

    // Heartbeat: mantem a conexao viva atraves de proxies com idle timeout.
    const heartbeat = setInterval(() => {
      raw.write(': hb\n\n');
    }, 25000);

    // close/error podem disparar os dois; clearInterval e unsubscribe sao
    // idempotentes, entao chamar o cleanup duas vezes e inofensivo.
    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
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
      // Fix pos-Codex (#2): valor insuficiente para o numero de parcelas pedido
      // vira 400 com mensagem clara, nao 500.
      if (err instanceof InstallmentsTooSmallError) {
        return reply.status(400).send({
          error: err.code,
          message: err.message,
          total_cents: err.total_cents,
          installments: err.installments,
        });
      }
      if (err instanceof InstallmentsNotAllowedError) {
        return reply.status(400).send({
          error: err.code,
          message: 'Venda parcelada nao e suportada.',
        });
      }
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

  // Entrega: atualiza status (pendente/saiu/entregue) e entregador de uma venda delivery.
  fastify.post('/parceiro/:slug/api/entregas/:orderId', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const params = saleParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'order_not_found' });
    const parsed = deliverySchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    try {
      return reply.status(200).send(await updatePartnerDeliveryStatus(getPartnerContext(request), params.data.orderId, parsed.data));
    } catch (err) {
      if (err instanceof DeliveryAlreadyFinalizedError) {
        return reply.status(409).send({ error: err.code, message: 'Esta entrega ja foi finalizada e nao pode ser reaberta.' });
      }
      if (err instanceof Error && err.message === 'delivery_not_found') {
        return reply.status(404).send({ error: 'delivery_not_found' });
      }
      // 0076: deliver_partner_local_order falha alto se a reserva for insuficiente, ou
      // se a entrega já estiver finalizada (backstop do guard de estado no TS).
      if (err instanceof Error && err.message.includes('Reserva insuficiente')) {
        return reply.status(409).send({ error: 'reserva_insuficiente', message: err.message });
      }
      if (err instanceof Error && err.message.includes('Entrega ja finalizada')) {
        return reply.status(409).send({ error: 'delivery_already_finalized', message: 'Esta entrega ja foi finalizada.' });
      }
      throw err;
    }
  });

  fastify.post('/parceiro/:slug/api/estoque', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = stockSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }
    try {
      return reply.status(200).send(await upsertPartnerStock(getPartnerContext(request), parsed.data));
    } catch (err) {
      if (err instanceof StockBelowReservedError) {
        return reply.status(409).send({
          error: err.code,
          message: 'O saldo fisico nao pode ficar abaixo da quantidade reservada em entregas abertas.',
        });
      }
      throw err;
    }
  });

  fastify.delete('/parceiro/:slug/api/estoque/:stockId', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = stockParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ error: 'stock_not_found' });

    try {
      const result = await deletePartnerStock(getPartnerContext(request), parsed.data.stockId);
      if (!result.deleted) return reply.status(404).send({ error: 'stock_not_found' });
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof StockReservedCannotDeleteError) {
        return reply.status(409).send({
          error: err.code,
          message: 'Este item tem quantidade reservada em entrega aberta e nao pode ser inativado agora.',
          stock_id: err.stock_id,
        });
      }
      throw err;
    }
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

    try {
      const result = await deletePartnerPurchase(getPartnerContext(request), parsed.data.purchaseId);
      if (!result.deleted) return reply.status(404).send({ error: 'purchase_not_found' });
      return reply.status(200).send(result);
    } catch (err) {
      // Fix pos-Codex (#3): compra com payable pago vinculado nao pode ser apagada
      if (err instanceof PaidPurchaseLockedError) {
        return reply.status(409).send({
          error: err.code,
          message: 'Esta compra ja foi paga. Para manter o financeiro correto, ela nao pode ser apagada. Faca ajuste manual/estorno em etapa futura.',
          purchase_id: err.purchase_id,
          paid_payable_id: err.paid_payable_id,
        });
      }
      // Fix pos-Codex (#4 mini-trava): se nao conseguiu estornar todos os itens, aborta
      if (err instanceof PartialStockReversalError) {
        return reply.status(409).send({
          error: err.code,
          message: 'Nao foi possivel localizar no estoque todos os itens desta compra para estornar. A compra nao foi apagada. Ajuste o estoque manualmente antes de tentar de novo.',
          failed_items: err.failed_items,
        });
      }
      throw err;
    }
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
    try {
      return reply.status(200).send(await registerPartnerPayable(getPartnerContext(request), parsed.data));
    } catch (err) {
      // status='paid' + force_duplicate=false pode disparar DuplicateExpenseError pelo helper interno
      if (err instanceof DuplicateExpenseError) {
        return reply.status(409).send({ error: err.code, duplicates: err.duplicates });
      }
      throw err;
    }
  });

  fastify.patch('/parceiro/:slug/api/contas-a-pagar/:payableId', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const params = payableParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'payable_not_found' });

    const parsed = payableUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }

    const result = await updatePartnerPayable(getPartnerContext(request), params.data.payableId, parsed.data);
    if (!result.updated) return reply.status(404).send({ error: 'payable_not_found_or_closed' });
    return reply.status(200).send(result);
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

    try {
      const result = await settlePartnerPayable(getPartnerContext(request), params.data.payableId, parsed.data);
      if (!result.paid) return reply.status(404).send({ error: 'payable_not_found' });
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof DuplicateExpenseError) {
        return reply.status(409).send({ error: err.code, duplicates: err.duplicates });
      }
      throw err;
    }
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

  fastify.patch('/parceiro/:slug/api/contas-a-receber/:receivableId', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const params = receivableParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'receivable_not_found' });

    const parsed = receivableUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }

    const result = await updatePartnerReceivable(getPartnerContext(request), params.data.receivableId, parsed.data);
    if (!result.updated) return reply.status(404).send({ error: 'receivable_not_found_or_closed' });
    return reply.status(200).send(result);
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

  fastify.post('/parceiro/:slug/api/contas-a-receber/:receivableId/parcelas/:installmentId/receber', { preHandler: requirePartnerAuth }, async (request: PartnerAuthedRequest, reply) => {
    const params = receivableInstallmentParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'installment_not_found' });

    const parsed = settleReceivableSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path?.join('.') || 'body';
      return reply.status(400).send({ error: `${path}: ${issue?.message ?? 'invalid'}` });
    }

    const result = await settlePartnerReceivableInstallment(
      getPartnerContext(request),
      params.data.receivableId,
      params.data.installmentId,
      parsed.data,
    );
    if (!result.received) return reply.status(404).send({ error: 'installment_not_found' });
    return reply.status(200).send(result);
  });
}
