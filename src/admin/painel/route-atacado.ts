// Obra 300 (2026-07-05): fatia da PORTARIA da matriz — atacado: venda/ranking/medidas/resumos + comissões/termos.
// VERBATIM das linhas 438-542 do route.ts pré-obra (corpo de registerPainelRoute).
// Registrada por ./route.js (porta de entrada) na ordem original.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { getCommissionLedger, getVarejoResumo, getWholesaleRanking, getWholesaleResumo, listWholesaleBuyers, listWholesaleMeasures, registerWholesaleSale, settleCommissionEntries, sweepCommissionEntries, updatePartnerCommercialTerms } from './queries.js';
import { dashboardPayload, mapWriteError, operatorLabel } from './route-helpers.js';
import { financePeriodQuerySchema, partnerIdParamSchema, partnerTermsSchema, registerWholesaleSaleSchema, settleComissaoSchema } from './route-schemas.js';

export async function registerPainelAtacado(fastify: FastifyInstance): Promise<void> {
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
}
