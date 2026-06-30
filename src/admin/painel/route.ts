import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import {
  approvePartnerApplication,
  cancelManualOrder,
  createPartnerApplication,
  createPartnerUnit,
  getMatrizResumo,
  getPainelPedidos,
  getPainelProdutos,
  getPainelRede,
  getRedeFunnel,
  getWholesaleRanking,
  getWholesaleResumo,
  listPartnerApplications,
  listWholesaleBuyers,
  listWholesaleMeasures,
  listWholesaleStock,
  setWholesaleStock,
  addWholesaleStockEntry,
  deleteWholesaleStock,
  registerManualOrder,
  registerWalkinOrder,
  registerWholesaleSale,
  listWholesaleSuppliers,
  registerWholesaleSupplier,
  getWholesaleSupplierRanking,
  getWholesaleSupplierMeasureBreakdown,
  registerWholesalePurchase,
  listWholesalePurchases,
  rejectPartnerApplication,
  setPartnerUnitDeliveryRadius,
} from './queries.js';

const publicDir = path.join(process.cwd(), 'painel', 'public');

const limitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const redeQuerySchema = z.object({
  period: z.enum(['today', '7d', '30d', 'month']).default('month'),
});

const resumoQuerySchema = z.object({
  period: z.enum(['today', '7d', '30d', 'month']).default('7d'),
});

// Onboarding de parceiro (Etapa 1). Termos comerciais são definidos pela matriz aqui,
// não pelo candidato. municipios = cobertura inicial; slug opcional (gerado do nome).
const createPartnerSchema = z.object({
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
const setDeliveryRadiusParamsSchema = z.object({
  partnerUnitId: z.string().uuid(),
});
const setDeliveryRadiusBodySchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  delivery_radius_km: z.number().positive().max(9999.99).nullable(),
});

// ATACADO (Fase 1): venda de atacado da Matriz. Comprador = ficha existente
// (customer_id), parceiro da rede (partner_id) OU só-atacado novo (new_customer).
// Preço DIGITADO por item. Admin-only (dado só da matriz).
const wholesaleItemSchema = z.object({
  measure: z.string().min(1).max(60),
  brand: z.string().min(1).max(60).nullable().optional(),
  quantity: z.number().int().positive().max(100000),
  unit_price: z.number().min(0).max(9999999.99),
});
const registerWholesaleSaleSchema = z
  .object({
    environment: z.enum(['prod', 'test']).optional(),
    customer_id: z.string().uuid().nullable().optional(),
    partner_id: z.string().uuid().nullable().optional(),
    new_customer: z
      .object({ name: z.string().min(1).max(200), phone: z.string().max(40).nullable().optional() })
      .nullable()
      .optional(),
    items: z.array(wholesaleItemSchema).min(1).max(50),
    sold_at: z.string().min(1).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
  })
  .refine(
    (d) => !!d.customer_id || !!d.partner_id || !!(d.new_customer && d.new_customer.name.trim()),
    { message: 'buyer_required' },
  );

// ATACADO (Fase 2): estoque do galpão por MEDIDA (gestão + autocomplete). Admin-only.
const setWholesaleStockSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  measure: z.string().min(1).max(60),
  quantity_on_hand: z.number().int().min(0).max(1000000),
  unit_cost: z.number().min(0).max(9999999.99).optional(),
  notes: z.string().max(1000).nullable().optional(),
});
const removeWholesaleStockSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  measure: z.string().min(1).max(60),
});
// Entrada de compra (custo médio): soma quantidade + recalcula o custo médio ponderado.
const entryWholesaleStockSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  measure: z.string().min(1).max(60),
  quantity_in: z.number().int().positive().max(1000000),
  unit_cost: z.number().min(0).max(9999999.99),
});

// ATACADO — FORNECEDORES (0114): cadastro + compra (entrada com origem). Admin-only.
const registerSupplierSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  name: z.string().min(1).max(200),
  phone: z.string().max(40).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});
const purchaseItemSchema = z.object({
  measure: z.string().min(1).max(60),
  brand: z.string().min(1).max(60).nullable().optional(),
  quantity: z.number().int().positive().max(100000),
  unit_cost: z.number().min(0).max(9999999.99),
});
const registerPurchaseSchema = z
  .object({
    environment: z.enum(['prod', 'test']).optional(),
    supplier_id: z.string().uuid().nullable().optional(),
    new_supplier: z
      .object({ name: z.string().min(1).max(200), phone: z.string().max(40).nullable().optional() })
      .nullable()
      .optional(),
    items: z.array(purchaseItemSchema).min(1).max(50),
    purchased_at: z.string().min(1).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
  })
  .refine((d) => !!d.supplier_id || !!(d.new_supplier && d.new_supplier.name.trim()), {
    message: 'supplier_required',
  });

// Etapa 3: candidatura pública "quero ser parceiro". 'website' é honeypot anti-spam.
const partnerApplicationSchema = z.object({
  trade_name: z.string().min(2),
  responsible_name: z.string().min(1).nullable().optional(),
  whatsapp_phone: z.string().min(1).nullable().optional(),
  // E-mail é opcional e sem validação de formato: o canal real é o WhatsApp.
  // Vazio vira null pra não derrubar o envio.
  email: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().max(160).nullable().optional(),
  ),
  address: z.string().min(1).nullable().optional(),
  municipios: z.string().min(1).nullable().optional(),
  message: z.string().max(1000).nullable().optional(),
  website: z.string().optional(),
});

const applicationsQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
});

// Aprovação: termos comerciais e cobertura REAL são definidos pelo dono aqui.
const approveApplicationSchema = z.object({
  municipios: z.array(z.string().min(1)).min(1),
  commission_percent: z.number().min(0).max(100).nullable().optional(),
  monthly_fee: z.number().min(0).nullable().optional(),
  commercial_model: z.string().min(1).nullable().optional(),
  slug: z.string().min(1).nullable().optional(),
});

const orderItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
  discount_amount: z.number().nonnegative().optional(),
});

// S6 da auditoria 2026-05-21: pedido de entrega exige endereco.
const requireDeliveryAddress = (data: { fulfillment_mode: string; delivery_address?: string | null }): boolean =>
  data.fulfillment_mode !== 'delivery' || !!(data.delivery_address && data.delivery_address.trim().length > 0);
const deliveryAddressRefineOpts = {
  message: 'delivery_address obrigatorio quando fulfillment_mode=delivery',
  path: ['delivery_address'] as (string | number)[],
};

const registerManualOrderSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  contact_id: z.string().uuid().optional(),
  conversation_id: z.string().uuid(),
  draft_id: z.string().uuid().nullable().optional(),
  unit_id: z.string().uuid().nullable().optional(),
  items: z.array(orderItemSchema).min(1),
  payment_method: z.string().min(1).nullable(),
  fulfillment_mode: z.enum(['delivery', 'pickup']),
  delivery_address: z.string().min(1).nullable().optional(),
  idempotency_key: z.string().min(8),
  source_tag: z.enum(['chatwoot_com_bot', 'chatwoot_sem_bot']).nullable().optional(),
}).refine(requireDeliveryAddress, deliveryAddressRefineOpts);

const registerWalkinOrderSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  customer_name: z.string().min(1).max(200).nullable().optional(),
  customer_phone: z.string().min(1).max(40).nullable().optional(),
  unit_id: z.string().uuid().nullable().optional(),
  items: z.array(orderItemSchema).min(1),
  payment_method: z.string().min(1).nullable(),
  fulfillment_mode: z.enum(['delivery', 'pickup']),
  delivery_address: z.string().min(1).nullable().optional(),
  idempotency_key: z.string().min(8),
  source_tag: z.enum(['walkin_balcao', 'walkin_telefone', 'walkin_outro']),
}).refine(requireDeliveryAddress, deliveryAddressRefineOpts);

const cancelParamsSchema = z.object({
  order_id: z.string().uuid(),
});

const cancelBodySchema = z.object({
  reason: z.string().min(1).max(500),
});

function operatorLabel(headers: Record<string, unknown>): string {
  const raw = headers['x-operator-label'];
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim().slice(0, 120);
  }
  return 'admin';
}

async function sendStatic(reply: FastifyReply, file: string, type: string) {
  const content = await readFile(path.join(publicDir, file));
  return reply.header('Content-Type', type).send(content);
}

function mapWriteError(err: unknown): { status: number; error: string } {
  if (!(err instanceof Error)) {
    return { status: 500, error: 'internal_server_error' };
  }

  if (err.message.includes('conversation_contact_not_found')) {
    return { status: 400, error: 'conversation_contact_not_found' };
  }

  if (
    err.message.includes('Pedido ja registrado') ||
    err.message.includes('duplicate key') ||
    err.message.includes('unique')
  ) {
    return { status: 409, error: 'already_registered' };
  }

  // Validações de escrita do galpão (atacado) — erro do usuário, não 500.
  if (['measure_not_in_catalog', 'measure_required', 'quantity_invalid', 'cost_invalid',
       'name_required', 'supplier_required', 'supplier_not_found', 'items_required'].includes(err.message)) {
    return { status: 400, error: err.message };
  }

  return { status: 500, error: 'internal_server_error' };
}

function dashboardPayload(rows: unknown[]) {
  const chatwootBaseUrl = env.CHATWOOT_API_BASE_URL?.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '') ?? null;
  return {
    environment: env.FAREJADOR_ENV,
    chatwoot_account_id: env.CHATWOOT_ACCOUNT_ID ?? null,
    chatwoot_base_url: chatwootBaseUrl,
    agent_v2_worker_enabled: env.AGENT_V2_WORKER_ENABLED,
    rows,
  };
}

export async function registerPainelRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/painel', async (_request, reply) => sendStatic(reply, 'index.html', 'text/html; charset=utf-8'));
  fastify.get('/admin/painel/', async (_request, reply) => sendStatic(reply, 'index.html', 'text/html; charset=utf-8'));
  fastify.get('/admin/painel/app.js', async (_request, reply) => sendStatic(reply, 'app.js', 'text/javascript; charset=utf-8'));
  fastify.get('/admin/painel/rede-fallback.js', async (_request, reply) => sendStatic(reply, 'rede-fallback.js', 'text/javascript; charset=utf-8'));
  fastify.get('/admin/painel/style.css', async (_request, reply) => sendStatic(reply, 'style.css', 'text/css; charset=utf-8'));
  fastify.get('/seja-parceiro-2w.png', async (_request, reply) => sendStatic(reply, 'seja-parceiro-2w.png', 'image/png'));

  fastify.get('/admin/api/dashboard/pedidos', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = limitQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send(dashboardPayload(await getPainelPedidos(parsed.data.limit)));
  });

  fastify.get('/admin/api/dashboard/produtos', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = limitQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send(dashboardPayload(await getPainelProdutos(parsed.data.limit)));
  });

  // Dados consolidados da Rede (parceiros, vendas, estoque, despesas, etc).
  // Lê de network.partner_unit_summary que agrega tudo do parceiro pra admin ver.
  fastify.get('/admin/api/dashboard/rede', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = redeQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    const [rows, funnel] = await Promise.all([getPainelRede(parsed.data.period), getRedeFunnel()]);
    const funilByUnit = new Map(
      funnel
        .filter((f) => f.unit_id)
        .map((f) => [String(f.unit_id), { tentou: f.tentou, pediu: f.pediu, efetivou: f.efetivou }] as const),
    );
    const merged = (rows as Array<Record<string, unknown>>).map((r) => ({
      ...r,
      funil: funilByUnit.get(String(r.unit_id)) ?? { tentou: 0, pediu: 0, efetivou: 0 },
    }));
    return reply.status(200).send(dashboardPayload(merged));
  });

  // Resumo do dono (cockpit da matriz): performance do bot/tráfego + leads a
  // recuperar. Lê (read-only) das views analytics derivadas do V2.
  fastify.get('/admin/api/dashboard/matriz-resumo', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = resumoQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    const resumo = await getMatrizResumo(parsed.data.period);
    return reply.status(200).send({ ...dashboardPayload([]), ...resumo });
  });

  // ── ATACADO (Fase 1): vendas de atacado da Matriz + ranking de recompra ──
  // Admin-only (dado SÓ da matriz; o parceiro nem tem grant no banco — migration 0110).

  // Compradores do formulário "Nova venda" (fichas já criadas + parceiros sem ficha).
  fastify.get('/admin/api/wholesale/buyers', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await listWholesaleBuyers()));
  });

  // Ranking de recompra (quem compra mais / quem sumiu / quem nunca comprou).
  fastify.get('/admin/api/wholesale/ranking', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await getWholesaleRanking()));
  });

  // Registrar uma venda de atacado (comprador + pneus + preço digitado).
  fastify.post('/admin/api/wholesale/sales', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = registerWholesaleSaleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await registerWholesaleSale({ ...parsed.data, created_by: operatorLabel(request.headers) });
      return reply.status(201).send(result);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale sale failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // ── ATACADO (Fase 2): estoque do galpão por medida + autocomplete de medidas ──
  // Admin-only (dado SÓ da matriz). A baixa na venda é Fase 2b (atrás de flag).

  // Medidas pro autocomplete da venda (catálogo ∪ estoque), com quantidade e custo.
  fastify.get('/admin/api/wholesale/measures', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await listWholesaleMeasures()));
  });

  // Resumo do atacado: faturamento, custo e lucro (Fase 3). Admin-only.
  fastify.get('/admin/api/wholesale/resumo', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send({ ...dashboardPayload([]), ...(await getWholesaleResumo()) });
  });

  // Estoque do galpão (uma linha por medida).
  fastify.get('/admin/api/wholesale/stock', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await listWholesaleStock()));
  });

  // ENTRADA de compra: soma a quantidade e recalcula o custo MÉDIO ponderado da medida.
  fastify.post('/admin/api/wholesale/stock/entry', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = entryWholesaleStockSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const row = await addWholesaleStockEntry(parsed.data);
      return reply.status(200).send(row);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale stock entry failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Define a quantidade de uma medida (upsert por medida).
  fastify.post('/admin/api/wholesale/stock', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = setWholesaleStockSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const row = await setWholesaleStock(parsed.data);
      return reply.status(200).send(row);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale stock set failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Remove uma medida do estoque do galpão.
  fastify.post('/admin/api/wholesale/stock/remove', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = removeWholesaleStockSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      await deleteWholesaleStock(parsed.data.measure, parsed.data.environment);
      return reply.status(200).send({ ok: true });
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale stock remove failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // ── ATACADO — FORNECEDORES (0114): cadastro + compra (entrada com origem) ──
  // Admin-only (dado SÓ da matriz; parceiro sem grant no banco). A compra alimenta
  // o custo médio do galpão na mesma transação (registerWholesalePurchase).

  // Lista de fornecedores (dropdown do formulário de compra + gestão).
  fastify.get('/admin/api/wholesale/suppliers', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await listWholesaleSuppliers()));
  });

  // Cadastra um fornecedor (nome + telefone).
  fastify.post('/admin/api/wholesale/suppliers', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = registerSupplierSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const row = await registerWholesaleSupplier(parsed.data);
      return reply.status(201).send(row);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale supplier failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Ranking de fornecedor (quanto comprei de cada / quem sumiu).
  fastify.get('/admin/api/wholesale/suppliers/ranking', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await getWholesaleSupplierRanking()));
  });

  // Quebra fornecedor × medida: "quem vende a medida X mais barato" + especialidade.
  fastify.get('/admin/api/wholesale/suppliers/breakdown', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await getWholesaleSupplierMeasureBreakdown()));
  });

  // Histórico de compras (cabeçalhos, mais recente primeiro).
  fastify.get('/admin/api/wholesale/purchases', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await listWholesalePurchases()));
  });

  // Registra uma COMPRA (entrada) → alimenta o custo médio do galpão (mesma transação).
  fastify.post('/admin/api/wholesale/purchases', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = registerPurchaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await registerWholesalePurchase({ ...parsed.data, created_by: operatorLabel(request.headers) });
      return reply.status(201).send(result);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale purchase failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Cadastro de parceiro (Etapa 1 onboarding): cria unidade + parceiro + LOGIN + cobertura.
  // O token (login) volta em texto SÓ aqui, uma vez. Admin-only.
  fastify.post('/admin/api/partners', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = createPartnerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await createPartnerUnit({ ...parsed.data, actor_label: operatorLabel(request.headers) });
      if (result.already_exists) {
        return reply.status(409).send({ error: 'slug_already_exists', slug: result.slug });
      }
      return reply.status(201).send(result);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel create partner failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // ADMIN: matriz define o raio de entrega de um parceiro (proximidade-primeiro Fase 2).
  // Só preenche o raio de quem JÁ faz entrega (não força entrega em quem é só retirada).
  fastify.put('/admin/api/partners/:partnerUnitId/delivery-radius', { preHandler: requireAdminAuth }, async (request, reply) => {
    const params = setDeliveryRadiusParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_partner_unit_id' });
    const body = setDeliveryRadiusBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: body.error.issues[0]?.message ?? 'invalid_body' });
    }
    const environment = body.data.environment ?? env.FAREJADOR_ENV;
    try {
      const result = await setPartnerUnitDeliveryRadius(environment, params.data.partnerUnitId, body.data.delivery_radius_km);
      if (!result.updated) {
        if (result.reason === 'not_found') return reply.status(404).send({ error: 'partner_not_found' });
        if (result.reason === 'pickup_only') return reply.status(409).send({ error: 'partner_pickup_only' });
        return reply.status(404).send({ error: 'partner_not_found' });
      }
      return reply.status(200).send({ updated: true, delivery_radius_km: body.data.delivery_radius_km });
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel set delivery radius failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // ── Etapa 3: candidaturas de parceiro (funil de recrutamento) ──

  // PÚBLICO (sem auth): formulário "quero ser parceiro" insere uma candidatura pendente.
  fastify.post('/api/seja-parceiro', async (request, reply) => {
    const parsed = partnerApplicationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    // honeypot: bots preenchem 'website'; humano deixa vazio → finge sucesso e não grava.
    if (parsed.data.website && parsed.data.website.trim().length > 0) {
      return reply.status(201).send({ ok: true });
    }
    try {
      const result = await createPartnerApplication(parsed.data);
      return reply.status(201).send({ ok: true, id: result.id });
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'partner application submit failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // PÚBLICO: a página do formulário.
  fastify.get('/seja-parceiro', async (_request, reply) =>
    sendStatic(reply, 'seja-parceiro.html', 'text/html; charset=utf-8'));

  // ADMIN: fila de candidaturas.
  fastify.get('/admin/api/partner-applications', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = applicationsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send(dashboardPayload(await listPartnerApplications(parsed.data.status)));
  });

  // ADMIN: aprovar candidatura → cria o parceiro (login + cobertura) e marca approved.
  fastify.post('/admin/api/partner-applications/:id/approve', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = approveApplicationSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    const { id } = request.params as { id: string };
    try {
      const result = await approvePartnerApplication({
        ...parsed.data,
        application_id: id,
        actor_label: operatorLabel(request.headers),
      });
      if (result.already_exists) return reply.status(409).send({ error: 'slug_already_exists', slug: result.slug });
      return reply.status(200).send(result);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'partner application approve failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // ADMIN: recusar candidatura.
  fastify.post('/admin/api/partner-applications/:id/reject', { preHandler: requireAdminAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { notes?: string };
    try {
      const result = await rejectPartnerApplication(id, operatorLabel(request.headers), body.notes ?? null);
      return reply.status(200).send(result);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'partner application reject failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/orders/register-manual', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = registerManualOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }

    try {
      const result = await registerManualOrder({
        ...parsed.data,
        actor_label: operatorLabel(request.headers),
      });
      return reply.status(200).send(result);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel manual order registration failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/orders/register-walkin', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = registerWalkinOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }

    try {
      const result = await registerWalkinOrder({
        ...parsed.data,
        actor_label: operatorLabel(request.headers),
      });
      return reply.status(200).send(result);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel walkin order registration failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/orders/:order_id/cancel', { preHandler: requireAdminAuth }, async (request, reply) => {
    const params = cancelParamsSchema.safeParse(request.params);
    const body = cancelBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: 'invalid_request' });
    }

    try {
      return reply.status(200).send(await cancelManualOrder({
        order_id: params.data.order_id,
        reason: body.data.reason,
        actor_label: operatorLabel(request.headers),
      }));
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel manual order cancellation failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

}
