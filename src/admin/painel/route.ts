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
  getVarejoResumo,
  sweepCommissionEntries,
  getCommissionLedger,
  settleCommissionEntries,
  updatePartnerCommercialTerms,
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
  getWholesaleFinance,
  settleWholesaleOrderPayment,
  settleWholesalePurchasePayment,
  getMatrizExpenses,
  createMatrizExpense,
  settleMatrizExpense,
  removeMatrizExpense,
  getMatrizFinanceiroVisao,
  MATRIZ_EXPENSE_CATEGORIES,
  getMatrizLogistica,
  setMatrizDeliveryStatus,
  failMatrizDelivery,
  openMatrizTrip,
  attachOrderToMatrizTrip,
  rescheduleMatrizDelivery,
  closeMatrizTrip,
  addMatrizTripReceipt,
  getMatrizTripReceiptImage,
  recordReceiptAiResult,
  listWholesaleSales,
  cancelWholesaleSale,
  rejectPartnerApplication,
  setPartnerUnitDeliveryRadius,
} from './queries.js';
import { reencodePhoto, PhotoRejectedError, PHOTO_MAX_UPLOAD_BYTES } from '../../parceiro/photo-upload.js';
import { readReceiptWithAI } from './receipt-ai.js';

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

// Recorte dos cards financeiros (atacado e varejo da matriz): mês corrente ou desde sempre.
const financePeriodQuerySchema = z.object({
  period: z.enum(['mes', 'tudo']).default('tudo'),
});

// Comissões da Rede (0118): quitar por parceiro + editor do modelo comercial.
const settleComissaoSchema = z.object({ partner_id: z.string().uuid() });
const partnerIdParamSchema = z.object({ partner_id: z.string().uuid() });
const partnerTermsSchema = z.object({
  commercial_model: z.enum(['commission', 'monthly', 'hybrid']),
  commission_percent: z.number().min(0).max(100).nullable(),
  monthly_fee: z.number().min(0).nullable(),
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
    allow_oversell: z.boolean().optional(),
    // FINANCEIRO (0115): 'pending' = fiado (a receber), vencimento opcional.
    // Ignorados com WHOLESALE_FINANCE off (a venda nasce 'paid', como hoje).
    payment_status: z.enum(['paid', 'pending']).optional(),
    due_date: z.string().date().nullable().optional(),
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
    // FINANCEIRO (0115): 'pending' = compra fiada (a pagar ao fornecedor).
    payment_status: z.enum(['paid', 'pending']).optional(),
    due_date: z.string().date().nullable().optional(),
  })
  .refine((d) => !!d.supplier_id || !!(d.new_supplier && d.new_supplier.name.trim()), {
    message: 'supplier_required',
  });

// FINANCEIRO do atacado (0115): quitar um fiado — venda (a receber) ou compra (a pagar).
const settleWholesaleFinanceSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  kind: z.enum(['sale', 'purchase']),
  id: z.string().uuid(),
});

// DESPESAS da matriz (0120): lançar (à vista × a pagar), quitar e remover (soft).
const createMatrizExpenseSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  category: z.enum(MATRIZ_EXPENSE_CATEGORIES),
  description: z.string().max(300).nullable().optional(),
  amount: z.number().positive(),
  payment_status: z.enum(['paid', 'pending']).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

const matrizExpenseIdSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  id: z.string().uuid(),
});

// CANCELAR venda de atacado (0116): registro errado sai do ranking/resumo/fiado
// e devolve o estoque (espelho da baixa). Motivo opcional (trilha).
const cancelWholesaleSaleSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  order_id: z.string().uuid(),
  reason: z.string().max(300).nullable().optional(),
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
      // Oversell: 409 com a lista de medidas que estouraram — o front avisa e reenvia com
      // allow_oversell se o caixa confirmar vender assim mesmo.
      if (err instanceof Error && err.message.startsWith('oversell:')) {
        return reply.status(409).send({ error: 'oversell', items: JSON.parse(err.message.slice(9)) });
      }
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
  fastify.get('/admin/api/wholesale/resumo', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = financePeriodQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send({ ...dashboardPayload([]), ...(await getWholesaleResumo(undefined, undefined, parsed.data.period)) });
  });

  // VAREJO da matriz (0117 — fatia 2): faturamento/custo/lucro com o custo CONGELADO na
  // venda, com recorte por mês. Mesma régua do card da aba Vendas (unit 'main', cancelado fora).
  fastify.get('/admin/api/varejo/resumo', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = financePeriodQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send({ ...dashboardPayload([]), ...(await getVarejoResumo(parsed.data.period)) });
  });

  // ── REDE — COMISSÕES COMO LANÇAMENTO (0118, flag NETWORK_COMMISSION_LEDGER) ──
  // O GET roda a VARREDURA (cria lançamento de venda 2W realizada; estorna o de venda
  // cancelada) e devolve o livro. Flag off → {enabled:false} e a UI some (nada é gravado).
  fastify.get('/admin/api/rede/comissoes', { preHandler: requireAdminAuth }, async (_request, reply) => {
    if (!env.NETWORK_COMMISSION_LEDGER) {
      return reply.status(200).send({ ...dashboardPayload([]), enabled: false });
    }
    const sweep = await sweepCommissionEntries();
    const ledger = await getCommissionLedger();
    return reply.status(200).send({ ...dashboardPayload([]), enabled: true, sweep, ...ledger });
  });

  // "Recebi": quita todos os lançamentos em aberto do parceiro.
  fastify.post('/admin/api/rede/comissoes/settle', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.NETWORK_COMMISSION_LEDGER) return reply.status(409).send({ error: 'ledger_disabled' });
    const parsed = settleComissaoSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    try {
      const result = await settleCommissionEntries({ partner_id: parsed.data.partner_id, settled_by: 'matriz-painel' });
      return reply.status(200).send(result);
    } catch (err) {
      if ((err as Error).message === 'nothing_open') return reply.status(404).send({ error: 'nothing_open' });
      logger.error({ err }, 'painel commission settle failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });

  // Editor do modelo comercial do parceiro (SEM flag — edição de cadastro, pendência 06-01).
  fastify.post('/admin/api/partners/:partner_id/terms', { preHandler: requireAdminAuth }, async (request, reply) => {
    const params = partnerIdParamSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_params' });
    const parsed = partnerTermsSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    try {
      const result = await updatePartnerCommercialTerms({
        partner_id: params.data.partner_id,
        commercial_model: parsed.data.commercial_model,
        commission_percent: parsed.data.commission_percent,
        monthly_fee: parsed.data.monthly_fee,
        actor_label: 'matriz-painel',
      });
      return reply.status(200).send(result);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === 'partner_not_found') return reply.status(404).send({ error: msg });
      if (msg === 'invalid_percent' || msg === 'invalid_fee') return reply.status(400).send({ error: msg });
      logger.error({ err }, 'painel partner terms update failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
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

  // ── ATACADO — FINANCEIRO (0115): o fiado do galpão (a receber / a pagar) ──
  // Admin-only + flag WHOLESALE_FINANCE (off = enabled:false, a UI se esconde).

  // Resumo do fiado: totais, vencidos e as listas em aberto.
  fastify.get('/admin/api/wholesale/finance', { preHandler: requireAdminAuth }, async (_request, reply) => {
    if (!env.WHOLESALE_FINANCE) {
      return reply.status(200).send({ ...dashboardPayload([]), enabled: false });
    }
    return reply.status(200).send({ ...dashboardPayload([]), enabled: true, ...(await getWholesaleFinance()) });
  });

  // Últimas vendas de atacado (vivas e canceladas — trilha visível). É de onde se cancela.
  fastify.get('/admin/api/wholesale/sales', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await listWholesaleSales()));
  });

  // CANCELA uma venda de atacado (0116): confirmed → cancelled + trilha + devolve estoque.
  fastify.post('/admin/api/wholesale/sales/cancel', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = cancelWholesaleSaleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await cancelWholesaleSale({
        order_id: parsed.data.order_id,
        reason: parsed.data.reason ?? null,
        environment: parsed.data.environment,
        cancelled_by: operatorLabel(request.headers),
      });
      return reply.status(200).send({ cancelled: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'sale_not_found') {
        return reply.status(404).send({ error: 'sale_not_found' });
      }
      if (err instanceof Error && err.message === 'sale_already_cancelled') {
        return reply.status(409).send({ error: 'sale_already_cancelled' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale sale cancel failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // QUITA um fiado (venda a receber OU compra a pagar). Quitar 2x → 404 (não sobrescreve).
  fastify.post('/admin/api/wholesale/finance/settle', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.WHOLESALE_FINANCE) return reply.status(404).send({ error: 'finance_disabled' });
    const parsed = settleWholesaleFinanceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = parsed.data.kind === 'sale'
        ? await settleWholesaleOrderPayment(parsed.data.id, parsed.data.environment)
        : await settleWholesalePurchasePayment(parsed.data.id, parsed.data.environment);
      return reply.status(200).send({ settled: true, ...result });
    } catch (err) {
      if (err instanceof Error && (err.message === 'receivable_not_found' || err.message === 'payable_not_found')) {
        return reply.status(404).send({ error: err.message });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale finance settle failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // ── MATRIZ — FINANCEIRO: VISÃO CONSOLIDADA (Onda 1, SÓ leitura) ──
  // A tela Financeiro inteira num GET: consolidado do mês (3 pernas − despesas),
  // a receber/a pagar juntos e indicadores. SEM flag própria — cada fatia respeita
  // a flag da sua fonte (fiado/comissão/despesas) e vem null com ela off.
  fastify.get('/admin/api/matriz/financeiro', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send({ ...dashboardPayload([]), ...(await getMatrizFinanceiroVisao()) });
  });

  // ── MATRIZ — DESPESAS GERAIS (0120, flag MATRIZ_EXPENSES): Fase A do livro-caixa ──
  // A perna de SAÍDA que faltava (aluguel/funcionário/combustível/frete/manutenção).
  // Admin-only + flag (off = enabled:false, a UI se esconde — padrão 0115/0118).

  // Resumo: a pagar (vencidos primeiro) + pago no mês + últimas despesas.
  fastify.get('/admin/api/matriz/despesas', { preHandler: requireAdminAuth }, async (_request, reply) => {
    if (!env.MATRIZ_EXPENSES) {
      return reply.status(200).send({ ...dashboardPayload([]), enabled: false });
    }
    return reply.status(200).send({ ...dashboardPayload([]), enabled: true, ...(await getMatrizExpenses()) });
  });

  // Lança despesa (à vista nasce paga; a pagar nasce pending com vencimento opcional).
  fastify.post('/admin/api/matriz/despesas', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_EXPENSES) return reply.status(404).send({ error: 'expenses_disabled' });
    const parsed = createMatrizExpenseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await createMatrizExpense({
        ...parsed.data,
        created_by: operatorLabel(request.headers),
      });
      return reply.status(201).send({ created: true, ...result });
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel matriz expense create failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // QUITA uma despesa a pagar (pending → paid). Quitar 2x → 404 (não sobrescreve).
  fastify.post('/admin/api/matriz/despesas/settle', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_EXPENSES) return reply.status(404).send({ error: 'expenses_disabled' });
    const parsed = matrizExpenseIdSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await settleMatrizExpense(parsed.data.id, parsed.data.environment);
      return reply.status(200).send({ settled: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'expense_not_found') {
        return reply.status(404).send({ error: 'expense_not_found' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel matriz expense settle failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // REMOVE despesa lançada errada (soft delete — trilha preservada).
  fastify.post('/admin/api/matriz/despesas/remove', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_EXPENSES) return reply.status(404).send({ error: 'expenses_disabled' });
    const parsed = matrizExpenseIdSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await removeMatrizExpense(parsed.data.id, parsed.data.environment);
      return reply.status(200).send({ removed: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'expense_not_found') {
        return reply.status(404).send({ error: 'expense_not_found' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel matriz expense remove failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // ── MATRIZ — LOGÍSTICA (0121, flag MATRIZ_LOGISTICS) ─────────────────────────
  // Entregas da 'main' nos moldes do parceiro + diário de rota do entregador
  // (km inicial/final, gasolina, comprovantes). "Não entregue" CANCELA no caminho
  // atômico (galpão volta pela trilha — fdd9148). IA do comprovante atrás de
  // MATRIZ_RECEIPT_AI: leu com certeza → despesa 0120 ('ia-comprovante'); sem
  // certeza → 'unreadable' (lançar na mão); erro de rede → fica 'pending' (ler de novo).

  // Parser de imagem: corpo cru como Buffer (mesmo funil do upload de foto do parceiro).
  for (const mime of ['image/jpeg', 'image/png', 'image/webp'] as const) {
    if (!fastify.hasContentTypeParser(mime)) {
      fastify.addContentTypeParser(mime, { parseAs: 'buffer' }, (_req, body, done) => {
        done(null, body);
      });
    }
  }

  const logisticaStatusSchema = z.object({
    order_id: z.string().uuid(),
    status: z.enum(['dispatched', 'delivered']),
    courier: z.string().max(120).optional().nullable(),
    payment_method: z.string().max(40).optional().nullable(),
  });
  const logisticaFalhouSchema = z.object({
    order_id: z.string().uuid(),
    reason: z.string().max(500).optional().nullable(),
  });
  const abrirRotaSchema = z.object({
    courier_name: z.string().min(1, 'courier_required').max(120),
    km_start: z.coerce.number().min(0).max(9999999).optional().nullable(),
    order_ids: z.array(z.string().uuid()).max(100).optional(),
  });
  const fecharRotaSchema = z.object({
    trip_id: z.string().uuid(),
    km_end: z.coerce.number().min(0).max(9999999).optional().nullable(),
    fuel_spent: z.coerce.number().min(0).max(99999).optional().nullable(),
    notes: z.string().max(500).optional().nullable(),
  });
  const pendurarRotaSchema = z.object({
    order_id: z.string().uuid(),
    trip_id: z.string().uuid(),
  });
  const remarcarEntregaSchema = z.object({
    order_id: z.string().uuid(),
    scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data_invalida'),
  });
  const comprovanteParamsSchema = z.object({ tripId: z.string().uuid() });
  const comprovanteIdParamsSchema = z.object({ receiptId: z.string().uuid() });
  const lerComprovanteSchema = z.object({ receipt_id: z.string().uuid() });

  // A tela num GET: entregas abertas/finalizadas + rotas abertas/recentes.
  fastify.get('/admin/api/logistica', { preHandler: requireAdminAuth }, async (_request, reply) => {
    if (!env.MATRIZ_LOGISTICS) {
      return reply.status(200).send({ ...dashboardPayload([]), enabled: false });
    }
    return reply.status(200).send({
      ...dashboardPayload([]),
      enabled: true,
      receipt_ai: env.MATRIZ_RECEIPT_AI,
      ...(await getMatrizLogistica()),
    });
  });

  // Saiu pra entrega / Entregue (entregue fecha o pedido; forma de pagamento opcional).
  fastify.post('/admin/api/logistica/entregas/status', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.status(404).send({ error: 'logistics_disabled' });
    const parsed = logisticaStatusSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await setMatrizDeliveryStatus(parsed.data);
      return reply.status(200).send({ updated: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'delivery_not_found') {
        return reply.status(404).send({ error: 'delivery_not_found' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel logistica status failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // NÃO ENTREGUE: marca failed e CANCELA (galpão volta) — atômico.
  fastify.post('/admin/api/logistica/entregas/falhou', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.status(404).send({ error: 'logistics_disabled' });
    const parsed = logisticaFalhouSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await failMatrizDelivery({
        ...parsed.data,
        actor_label: operatorLabel(request.headers),
      });
      return reply.status(200).send({ failed: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'delivery_not_found') {
        return reply.status(404).send({ error: 'delivery_not_found' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel logistica falhou failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // REMARCA a data prevista de entrega (agendamento — 07-03e). Toda entrega nasce
  // pra D+1; aqui o dono empurra pra outro dia (ex.: não entregou no dia).
  fastify.post('/admin/api/logistica/entregas/remarcar', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.status(404).send({ error: 'logistics_disabled' });
    const parsed = remarcarEntregaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await rescheduleMatrizDelivery(parsed.data);
      return reply.status(200).send({ rescheduled: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'delivery_not_found') {
        return reply.status(404).send({ error: 'delivery_not_found' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel logistica remarcar failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // ABRE a rota do dia (as entregas escolhidas saem juntas — dispatched).
  fastify.post('/admin/api/logistica/rotas', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.status(404).send({ error: 'logistics_disabled' });
    const parsed = abrirRotaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await openMatrizTrip({
        ...parsed.data,
        created_by: operatorLabel(request.headers),
      });
      return reply.status(201).send({ created: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'trip_needs_delivery') {
        return reply.status(400).send({ error: 'trip_needs_delivery' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel logistica abrir rota failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // PENDURA uma entrega numa rota JÁ ABERTA (o "pendurar depois" — decisão do dono
  // 07-03c). Mesma amarra do vínculo na abertura; só entrega da main, fora de rota,
  // em rota aberta.
  fastify.post('/admin/api/logistica/rotas/pendurar', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.status(404).send({ error: 'logistics_disabled' });
    const parsed = pendurarRotaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await attachOrderToMatrizTrip(parsed.data);
      return reply.status(200).send({ attached: true, ...result });
    } catch (err) {
      if (err instanceof Error && (err.message === 'trip_not_open' || err.message === 'delivery_not_found')) {
        return reply.status(404).send({ error: err.message });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel logistica pendurar rota failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // FECHA a rota (km final + gasolina + observação). Gasolina sem comprovante-despesa
  // → lança 'combustivel' no 0120 na mesma transação (anti-dupla-contagem).
  fastify.post('/admin/api/logistica/rotas/fechar', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.status(404).send({ error: 'logistics_disabled' });
    const parsed = fecharRotaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await closeMatrizTrip(parsed.data);
      return reply.status(200).send({ closed: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'trip_not_found') {
        return reply.status(404).send({ error: 'trip_not_found' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel logistica fechar rota failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Comprovante da rota: corpo = bytes da imagem. Valida tipo REAL + re-encoda
  // (funil blindado da foto). Com a IA ligada, tenta ler JÁ na resposta.
  fastify.post('/admin/api/logistica/rotas/:tripId/comprovante', {
    preHandler: requireAdminAuth,
    bodyLimit: PHOTO_MAX_UPLOAD_BYTES,
  }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.status(404).send({ error: 'logistics_disabled' });
    const params = comprovanteParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'trip_not_found' });

    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.status(415).send({ error: 'not_an_image' });
    }
    let photo;
    try {
      photo = await reencodePhoto(body);
    } catch (err) {
      if (err instanceof PhotoRejectedError) {
        return reply.status(415).send({ error: err.reason });
      }
      throw err;
    }

    let receipt;
    try {
      receipt = await addMatrizTripReceipt({
        trip_id: params.data.tripId,
        bytes: photo.bytes,
        mime: photo.mime,
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'trip_not_found') {
        return reply.status(404).send({ error: 'trip_not_found' });
      }
      if (err instanceof Error && err.message === 'receipt_limit') {
        return reply.status(400).send({ error: 'receipt_limit' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel logistica comprovante failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }

    // IA inline (o painel espera com spinner). Erro de transporte NÃO derruba o
    // upload: o comprovante fica 'pending' com "ler de novo" na tela.
    let ai: { ai_status: string; ai_summary?: string | null; ai_expense_id?: string | null; linked_existing?: boolean } = { ai_status: receipt.ai_status };
    if (env.MATRIZ_RECEIPT_AI) {
      try {
        const reading = await readReceiptWithAI(photo.bytes, photo.mime);
        const recorded = await recordReceiptAiResult({
          receipt_id: receipt.receipt_id,
          result: reading.kind === 'parsed'
            ? { kind: 'parsed', category: reading.category, amount: reading.amount, summary: reading.summary }
            : { kind: 'unreadable', summary: reading.summary },
        });
        ai = { ai_status: recorded.ai_status, ai_summary: reading.summary, ai_expense_id: recorded.ai_expense_id, linked_existing: recorded.linked_existing };
      } catch (err) {
        logger.warn({ err, receiptId: receipt.receipt_id }, 'leitura de comprovante falhou (fica pending)');
      }
    }
    return reply.status(201).send({ ok: true, receipt_id: receipt.receipt_id, ...ai });
  });

  // Re-tenta a leitura de um comprovante pending/unreadable (idempotente: já lançado não duplica).
  fastify.post('/admin/api/logistica/comprovantes/ler', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS || !env.MATRIZ_RECEIPT_AI) return reply.status(404).send({ error: 'receipt_ai_disabled' });
    const parsed = lerComprovanteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    const img = await getMatrizTripReceiptImage(parsed.data.receipt_id);
    if (!img) return reply.status(404).send({ error: 'receipt_not_found' });
    try {
      const reading = await readReceiptWithAI(img.bytes, img.mime);
      const recorded = await recordReceiptAiResult({
        receipt_id: parsed.data.receipt_id,
        result: reading.kind === 'parsed'
          ? { kind: 'parsed', category: reading.category, amount: reading.amount, summary: reading.summary }
          : { kind: 'unreadable', summary: reading.summary },
      });
      return reply.status(200).send({ ok: true, ...recorded, ai_summary: reading.summary });
    } catch (err) {
      logger.warn({ err, receiptId: parsed.data.receipt_id }, 're-leitura de comprovante falhou');
      return reply.status(502).send({ error: 'ai_unavailable' });
    }
  });

  // Bytes do comprovante (miniatura/lightbox da rota).
  fastify.get('/admin/api/logistica/comprovantes/:receiptId/imagem', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.status(404).send({ error: 'logistics_disabled' });
    const params = comprovanteIdParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'receipt_not_found' });
    const img = await getMatrizTripReceiptImage(params.data.receiptId);
    if (!img) return reply.status(404).send({ error: 'receipt_not_found' });
    return reply
      .header('Content-Type', img.mime)
      .header('Cache-Control', 'private, max-age=3600')
      .status(200)
      .send(img.bytes);
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
