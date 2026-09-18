import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import type { CaixaAuth } from './queries.js';
import { listWholesaleSuppliers } from '../painel/queries-fornecedores.js';
import { listWholesaleMeasures } from '../painel/queries-galpao-medidas.js';
import { getWholesalePurchaseReport } from '../painel/queries-compras-relatorios.js';
import { getWholesalePriceReport } from '../painel/queries-compras-precos.js';
import { priceReportQuerySchema } from '../painel/price-report-query.js';
import { getWholesaleFinance } from '../painel/queries-fiado-despesas.js';
import { confirmWholesalePurchase, registerWholesalePurchase } from '../painel/queries-fornecedores-registro.js';
import { confirmWholesalePurchaseSchema, registerPurchaseSchema } from '../painel/route-schemas-purchases.js';
import { registerLotPurchaseSchema } from '../painel/route-schemas-lot-purchases.js';
import { purchaseReportQuerySchema } from '../painel/purchase-report-query.js';
import { calculateWholesalePurchaseMoney } from '../painel/purchase-money.js';
import { calculateLotPurchaseMoney } from '../painel/lot-purchase-money.js';
import { mapWriteError } from '../painel/route-helpers.js';

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type AuthRequest = FastifyRequest & { caixa?: CaixaAuth };
const base = '/api/caixa/operacao/compras';
const allPurchases = { period: 'all', status: 'all', payment: 'all', page: 1, pageSize: 4 } as const;

function actor(request: FastifyRequest): string {
  const auth = (request as AuthRequest).caixa!;
  return `Caixa: ${auth.displayName} (${auth.username})`.slice(0, 120);
}

function writeError(reply: FastifyReply, error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'purchase_not_found') return reply.status(404).send({ error: code });
  if (['purchase_already_confirmed', 'purchase_already_cancelled'].includes(code)) {
    return reply.status(409).send({ error: code });
  }
  const mapped = mapWriteError(error);
  logger.error({ err: error, status: mapped.status }, 'operation purchase failed');
  return reply.status(mapped.status).send({ error: mapped.error });
}

/** Authentication adapter only: purchases, costing, inventory and ledger use the web engine. */
export function registerCaixaPurchaseRoutes(
  fastify: FastifyInstance, flagGate: Guard, requireAuth: Guard, requireStock: Guard,
): void {
  const owner: Guard = async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if ((request as AuthRequest).caixa?.panelRole !== 'owner') {
      await reply.status(403).send({ error: 'forbidden' });
    }
  };
  const options = { preHandler: [flagGate, requireAuth, requireStock, owner] };

  fastify.get(base + '/medidas', options, async () => ({
    rows: await listWholesaleMeasures(env.FAREJADOR_ENV),
  }));

  fastify.get(base + '/precos', options, async (request, reply) => {
    const parsed = priceReportQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    const q = parsed.data;
    return { rows: await getWholesalePriceReport({ period: q.period, from: q.from, to: q.to,
      supplierId: q.supplier_id, search: q.search }, env.FAREJADOR_ENV) };
  });

  fastify.get(base + '/contexto', options, async () => ({
    suppliers: await listWholesaleSuppliers(env.FAREJADOR_ENV),
    credit_enabled: env.WHOLESALE_FINANCE,
  }));

  fastify.get(base + '/resumo', options, async () => {
    const [report, finance] = await Promise.allSettled([
      getWholesalePurchaseReport(allPurchases, env.FAREJADOR_ENV),
      getWholesaleFinance(env.FAREJADOR_ENV),
    ]);
    if (report.status === 'rejected') logger.warn({ err: report.reason }, 'purchase summary unavailable');
    if (finance.status === 'rejected') logger.warn({ err: finance.reason }, 'purchase payables unavailable');
    return {
      pending_receipts: report.status === 'fulfilled' ? report.value.summary.pending_receipts : null,
      payable_total: finance.status === 'fulfilled' ? finance.value.a_pagar_total : null,
    };
  });

  fastify.get(base, options, async (request, reply) => {
    const parsed = purchaseReportQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    const q = parsed.data;
    return getWholesalePurchaseReport({
      period: q.period, status: q.status, payment: q.payment, search: q.search,
      supplierId: q.supplier_id, page: q.page, pageSize: q.page_size,
    }, env.FAREJADOR_ENV);
  });

  for (const preview of [true, false]) {
    fastify.post(base + (preview ? '/revisao' : ''), options, async (request, reply) => {
      const parsed = registerPurchaseSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message, issues: parsed.error.issues });
      try {
        if (parsed.data.payment_status === 'pending' && !env.WHOLESALE_FINANCE) throw new Error('wholesale_finance_disabled');
        if (preview) return calculateWholesalePurchaseMoney(parsed.data.items, parsed.data.freight_amount, parsed.data.discount_amount);
        const result = await registerWholesalePurchase({
          ...parsed.data, environment: env.FAREJADOR_ENV, created_by: actor(request),
        });
        return reply.status(201).send(result);
      } catch (error) { return writeError(reply, error); }
    });
    fastify.post(base + '/lotes' + (preview ? '/revisao' : ''), options, async (request, reply) => {
      const parsed = registerLotPurchaseSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message, issues: parsed.error.issues });
      try {
        if (parsed.data.payment_status === 'pending' && !env.WHOLESALE_FINANCE) throw new Error('wholesale_finance_disabled');
        if (preview) return calculateLotPurchaseMoney(parsed.data.lot, parsed.data.freight_amount, parsed.data.discount_amount);
        const result = await registerWholesalePurchase({
          ...parsed.data, items: [], environment: env.FAREJADOR_ENV, created_by: actor(request),
        });
        return reply.status(201).send(result);
      } catch (error) { return writeError(reply, error); }
    });
  }
  fastify.post(base + '/confirmar', options, async (request, reply) => {
    const parsed = confirmWholesalePurchaseSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message });
    try {
      return await confirmWholesalePurchase({
        ...parsed.data, environment: env.FAREJADOR_ENV, confirmed_by: actor(request),
      });
    } catch (error) { return writeError(reply, error); }
  });
}
