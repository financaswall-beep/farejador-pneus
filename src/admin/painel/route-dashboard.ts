// Obra 300 (2026-07-05): fatia da PORTARIA da matriz — dashboard: pedidos/produtos/rede/matriz-resumo.
// VERBATIM das linhas 395-437 do route.ts pré-obra (corpo de registerPainelRoute).
// Registrada por ./route.js (porta de entrada) na ordem original.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { getMatrizResumo, getPainelPedidos, getPainelProdutos, getPainelRede, getRedeFunnel } from './queries.js';
import { dashboardPayload } from './route-helpers.js';
import { limitQuerySchema, redeQuerySchema, resumoQuerySchema } from './route-schemas.js';

export async function registerPainelDashboard(fastify: FastifyInstance): Promise<void> {
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
}
