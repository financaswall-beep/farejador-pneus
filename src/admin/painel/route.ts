/**
 * PORTARIA da matriz — porta de entrada (obra 300, 2026-07-05).
 *
 * O route.ts de 1.399 linhas foi fatiado em 12 módulos de rotas por ASSUNTO
 * (route-*.ts) + mezanino (route-schemas / route-helpers), todos ≤300 (fiscal).
 * Este arquivo só registra os módulos NA ORDEM do arquivo original.
 * Rota nova entra no MÓDULO do assunto, nunca aqui. Prova: prova-rotas-matriz.
 */
import type { FastifyInstance } from 'fastify';
import { registerPainelStatic } from './route-static.js';
import { registerPainelDashboard } from './route-dashboard.js';
import { registerPainelAtacado } from './route-atacado.js';
import { registerPainelGalpao } from './route-galpao.js';
import { registerPainelFornecedores } from './route-fornecedores.js';
import { registerPainelFiado } from './route-fiado.js';
import { registerPainelFinanceiro } from './route-financeiro.js';
import { registerPainelLogistica } from './route-logistica.js';
import { registerPainelLogisticaRotas } from './route-logistica-rotas.js';
import { registerPainelParceiros } from './route-parceiros.js';
import { registerPainelCandidaturas } from './route-candidaturas.js';
import { registerPainelPedidos } from './route-pedidos.js';
import { registerPainelColaboradores } from './route-colaboradores.js';
import { registerPainelNotificacoes } from './route-notificacoes.js';

export async function registerPainelRoute(fastify: FastifyInstance): Promise<void> {
  await registerPainelStatic(fastify); // estáticos do painel (index/app.js/módulos/css) (linhas 377-394 pré-obra)
  await registerPainelDashboard(fastify); // dashboard: pedidos/produtos/rede/matriz-resumo (linhas 395-437 pré-obra)
  await registerPainelAtacado(fastify); // atacado: venda/ranking/medidas/resumos + comissões/termos (linhas 438-542 pré-obra)
  await registerPainelGalpao(fastify); // estoque do galpão (entrada/definir/remover) (linhas 543-599 pré-obra)
  await registerPainelFornecedores(fastify); // fornecedores + compras (linhas 600-654 pré-obra)
  await registerPainelFiado(fastify); // fiado do atacado + últimas vendas + cancelar (linhas 655-719 pré-obra)
  await registerPainelFinanceiro(fastify); // visão do financeiro + despesas (0120) (linhas 720-848 pré-obra)
  await registerPainelLogistica(fastify); // logística (0121) leitura + parser/schemas (796-947 pré-obra)
  await registerPainelLogisticaRotas(fastify); // logística rotas/comprovantes+IA (948-1115 pré-obra)
  await registerPainelParceiros(fastify); // cadastro de parceiro + raio de entrega (linhas 1116-1161 pré-obra)
  await registerPainelCandidaturas(fastify); // seja-parceiro (público) + fila de candidaturas (linhas 1162-1225 pré-obra)
  await registerPainelPedidos(fastify); // pedido manual/walk-in + cancelar (linhas 1226-1283 pré-obra)
  await registerPainelColaboradores(fastify); // colaboradores da matriz (0124) (linhas 1284-1398 pré-obra)
  await registerPainelNotificacoes(fastify); // sino do painel (2026-07-06): notificações reais
}
