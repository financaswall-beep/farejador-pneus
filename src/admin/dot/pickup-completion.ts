import type { PoolClient } from 'pg';
import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { pickupServiceDefinition, pickupServicesSchema, type PickupServiceCode } from '../../shared/pickup-services.js';
import { completeMatrizPickupInTransaction } from '../painel/queries-pedidos-acoes.js';
import { readMatrizPickupCancellationCandidate } from '../painel/queries-pickup-cancel.js';
import { hasCentPrecision } from '../painel/sales-money.js';
import { beginIntegrityOperation, completeIntegrityOperation, integrityResult, moneyCents, operationFingerprint } from '../painel/stage5-integrity.js';
import { lockGrant, transact } from './installment-reviews.js';
import { markOperationExecuted, requireOperationReview } from './operation-reviews.js';
import type { DotIdentity } from './token-store.js';

export const completePickupTool = 'concluir_retirada_matriz';
export const pickupCompletionSchema = z.object({
  retirada_id: z.string().uuid(),
  revisao: z.string().regex(/^[a-f0-9]{64}$/).describe('Revisão retornada pela consulta de conclusão desta retirada.'),
  forma_pagamento: z.enum(['pix', 'dinheiro', 'cartao', 'debito', 'credito', 'transferencia']),
  valor_recebido: z.number().nonnegative().max(99_999_999.99).refine(hasCentPrecision)
    .describe('Valor total, em reais, que o dono informou ter recebido nesta retirada.'),
  idempotency_key: z.string().uuid().describe('Use a mesma chave ao repetir a proposta autorizada.'),
}).strict();

const movementSchema = z.array(z.object({
  measure: z.string().min(1), brand: z.string(), tire_condition: z.enum(['novo', 'meia_vida', 'remold']),
  qty: z.number().int().positive(),
})).min(1);

type PickupContext = {
  pickup_services: unknown;
  tire_items: Array<{ productId: string; quantity: number }>;
  services_posted: Array<{ code: PickupServiceCode; amount: string }>;
  active_movements: unknown;
};

async function readPickupCompletion(
  db: Pick<PoolClient, 'query'>,
  lookup: Parameters<typeof readMatrizPickupCancellationCandidate>[2],
  lock: boolean,
) {
  const environment = env.FAREJADOR_ENV;
  const candidate = await readMatrizPickupCancellationCandidate(db, environment, lookup, lock);
  const { total, ...ficha } = candidate.ficha;
  const context = (await db.query<PickupContext>(
    `SELECT o.pickup_services,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('productId',i.product_id,'quantity',i.quantity) ORDER BY i.id)
                    FROM commerce.order_items i
                    JOIN commerce.products p ON p.environment=i.environment AND p.id=i.product_id AND p.product_type='tire'
                   WHERE i.environment=o.environment AND i.order_id=o.id),'[]'::jsonb) tire_items,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('code',i.pickup_service_code,'amount',i.unit_price::text) ORDER BY i.id)
                    FROM commerce.order_items i WHERE i.environment=o.environment AND i.order_id=o.id
                    AND i.pickup_service_code IS NOT NULL),'[]'::jsonb) services_posted,
        (SELECT a.payload_after->'movements' FROM audit.events a
          WHERE a.environment=o.environment AND a.entity_id=o.id AND a.entity_table='commerce.wholesale_stock'
            AND a.event_type IN ('matriz_galpao_reserved','matriz_galpao_reservation_adjusted')
            AND NOT EXISTS (SELECT 1 FROM audit.events used WHERE used.environment=o.environment
              AND used.entity_id=o.id AND used.entity_table=a.entity_table
              AND used.event_type IN ('matriz_galpao_decrement','matriz_galpao_reservation_released'))
          ORDER BY a.created_at DESC,a.id DESC LIMIT 1) active_movements
       FROM commerce.orders o WHERE o.environment=$1 AND o.id=$2`,
    [environment, ficha.retirada_id],
  )).rows[0]!;
  const movements = movementSchema.safeParse(context.active_movements);
  const quantity = context.tire_items.reduce((sum, item) => sum + item.quantity, 0);
  if (!movements.success || movements.data.reduce((sum, move) => sum + move.qty, 0) !== quantity) {
    throw Error('retirada_sem_reserva_ativa_compativel');
  }

  const services = pickupServicesSchema.safeParse(context.pickup_services ?? []);
  if (!services.success || context.services_posted.some(posted => !services.data.some(
    service => service.code === posted.code && service.amount_cents === moneyCents(Number(posted.amount)),
  ))) throw Error('servicos_da_retirada_inconsistentes');
  const additionalCents = services.data.filter(service => !context.services_posted.some(posted => posted.code === service.code))
    .reduce((sum, service) => sum + service.amount_cents, 0);
  const amountCents = moneyCents(Number(total)) + additionalCents;
  return {
    ficha: { ...ficha, valor_total_com_servicos: amountCents / 100, baixa_unidades: quantity,
      estoque_a_baixar: movements.data.map(({ measure, brand, tire_condition, qty }) => ({
        medida: measure, marca: brand, condicao: tire_condition, quantidade: qty,
      })),
      servicos: services.data.map(service => ({ ...service, descricao: pickupServiceDefinition(service.code).label })) },
    revisao: operationFingerprint({ retirada: candidate.revisao, context }),
    amountCents,
  };
}

export async function readPickupCompletionCandidate(
  db: Pick<PoolClient, 'query'>, lookup: Parameters<typeof readPickupCompletion>[1],
) {
  const { ficha, revisao } = await readPickupCompletion(db, lookup, false);
  return { ficha, revisao };
}

export async function requestPickupCompletion(identity: DotIdentity, args: unknown) {
  const request = pickupCompletionSchema.parse(args);
  const { retirada_id, revisao, forma_pagamento, valor_recebido, idempotency_key } = request;
  const environment = env.FAREJADOR_ENV;
  return transact(async db => {
    const grant = await lockGrant(db, identity.person_id, identity.grant_id);
    const pending = await requireOperationReview(db, identity, completePickupTool, idempotency_key, async () => {
      const candidate = await readPickupCompletion(db, { order_id: retirada_id }, true);
      if (candidate.revisao !== revisao) throw Error('retirada_alterada_consulte_novamente');
      if (moneyCents(valor_recebido) !== candidate.amountCents) throw Error('valor_recebido_difere_do_total_da_retirada');
      return { ...request, ficha: candidate.ficha };
    }, grant, 'pickup_completion');
    if (pending) return pending;

    const operation = { environment, domain: 'dot.' + completePickupTool, idempotencyKey: idempotency_key,
      fingerprint: operationFingerprint({ grant: identity.grant_id, retirada_id, revisao, forma_pagamento, valor_recebido }) };
    const previous = await beginIntegrityOperation<Record<string, unknown>>(db, operation);
    if (previous.replayed) return previous.result;
    const completion = await completeMatrizPickupInTransaction(db, {
      environment, order_id: retirada_id, actor_label: 'Milly · ' + identity.person_id, payment_method: forma_pagamento,
    });
    const result = integrityResult({ status: 'executada', executada: true,
      resultado: { retirada_id, ...completion, valor_recebido, forma_pagamento } });
    await completeIntegrityOperation(db, operation, 'commerce.orders', retirada_id, result);
    await markOperationExecuted(db, identity, completePickupTool, idempotency_key);
    return result;
  });
}
