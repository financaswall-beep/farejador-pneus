import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { CancelManualOrderInput } from './queries-pedidos.js';
import { applyMatrizGalpaoReturn } from '../../atendente-v2/wholesale-stock-read.js';
import { releaseMatrizGalpaoReservation } from '../../atendente-v2/matriz-stock-reservation.js';
import { postMatrizRetailCancellation } from './matriz-ledger-retail-sales.js';
import { operationFingerprint } from './stage5-integrity.js';

type PickupLookup = { order_id: string } | { order_number: string };
type PickupCandidate = {
  retirada_id: string;
  numero_pedido: string | null;
  cliente: string;
  total: string;
  situacao: 'aguardando' | 'pronto_para_retirar' | 'cliente_chegou' | 'instalando';
  itens: Array<{ produto: string; medida: string | null; marca: string | null; condicao: string | null; quantidade: number }>;
  updated_at: string;
};

/** Mesma seleção da operação de cancelamento, usada também para identificar a retirada. */
export async function readMatrizPickupCancellationCandidate(
  db: Pick<PoolClient, 'query'>,
  environment: 'prod' | 'test',
  lookup: PickupLookup,
  lock = false,
) {
  const result = await db.query<PickupCandidate>(
    `SELECT pickup.id retirada_id,pickup.order_number::text numero_pedido,
            COALESCE(NULLIF(pickup.customer_name,''),NULLIF(contact.name,''),'Cliente sem nome') cliente,
            pickup.total_amount::text total,EXTRACT(epoch FROM pickup.updated_at)::text updated_at,
            CASE WHEN pickup.pickup_installation_started_at IS NOT NULL THEN 'instalando'
                 WHEN pickup.pickup_arrived_at IS NOT NULL THEN 'cliente_chegou'
                 WHEN pickup.pickup_ready_at IS NOT NULL THEN 'pronto_para_retirar' ELSE 'aguardando' END situacao,
            COALESCE(items.rows,'[]'::jsonb) itens
       FROM commerce.orders pickup
       JOIN core.units unit
         ON unit.environment=pickup.environment AND unit.id=pickup.unit_id
       LEFT JOIN core.contacts contact
         ON contact.environment=pickup.environment AND contact.id=pickup.contact_id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'produto',product.product_name,'medida',spec.tire_size,'marca',product.brand,
           'condicao',COALESCE(item.tire_condition,product.tire_condition),'quantidade',item.quantity
         ) ORDER BY item.created_at,item.id) rows
           FROM commerce.order_items item
           JOIN commerce.products product ON product.environment=item.environment AND product.id=item.product_id
           LEFT JOIN commerce.tire_specs spec ON spec.environment=item.environment AND spec.product_id=item.product_id
          WHERE item.environment=pickup.environment AND item.order_id=pickup.id
       ) items ON true
      WHERE pickup.environment=$1 AND (pickup.id=$2::uuid OR pickup.order_number=$3::text)
        AND pickup.partner_order_id IS NULL
        AND pickup.fulfillment_mode='pickup' AND pickup.status='open'
        AND unit.slug='main'
        AND EXISTS (SELECT 1 FROM audit.events reservation
                     WHERE reservation.environment=pickup.environment
                       AND reservation.entity_id=pickup.id
                       AND reservation.entity_table='commerce.wholesale_stock'
                       AND reservation.event_type='matriz_galpao_reserved')
      LIMIT 2 ${lock ? 'FOR UPDATE OF pickup' : ''}`,
    [environment, 'order_id' in lookup ? lookup.order_id : null, 'order_number' in lookup ? lookup.order_number : null],
  );
  if (!result.rows[0]) throw new Error('pickup_not_found');
  if (result.rows.length > 1) throw new Error('pickup_ambiguous');
  const { updated_at: _updatedAt, ...ficha } = result.rows[0];
  return { ficha, revisao: operationFingerprint(result.rows[0]) };
}

export async function cancelMatrizPickupInTransaction(
  client: PoolClient,
  input: CancelManualOrderInput & { expected_revision?: string },
): Promise<{ cancelled: true }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const candidate = await readMatrizPickupCancellationCandidate(client, environment, { order_id: input.order_id }, true);
  if (input.expected_revision && candidate.revisao !== input.expected_revision) {
    throw new Error('retirada_alterada_consulte_novamente');
  }
  await client.query('SELECT commerce.cancel_manual_order($1, $2, $3)', [
    input.order_id,
    input.actor_label,
    input.reason,
  ]);
  await releaseMatrizGalpaoReservation(client, environment, input.order_id);
  await applyMatrizGalpaoReturn(client, environment, input.order_id);
  const cancelled = await client.query<{ updated_at: string }>(
    `SELECT updated_at FROM commerce.orders WHERE id=$1 AND environment=$2`,
    [input.order_id, environment],
  );
  await postMatrizRetailCancellation(
    client, environment, input.order_id, cancelled.rows[0]!.updated_at,
    input.actor_label, input.reason,
  );
  return { cancelled: true };
}

/**
 * Cancela somente uma retirada aberta e reservada da Matriz.
 *
 * A rota operacional possui um poder mais estreito que o cancelamento geral do
 * painel: mesmo com um UUID válido, ela nunca pode cancelar venda de balcão,
 * atacado ou pedido de outra unidade.
 */
export async function cancelMatrizPickup(
  input: CancelManualOrderInput,
  dbPool: Pool = defaultPool,
): Promise<{ cancelled: true }> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await cancelMatrizPickupInTransaction(client, input);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
