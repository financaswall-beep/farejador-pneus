import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { CancelManualOrderInput } from './queries-pedidos.js';
import { applyMatrizGalpaoReturn } from '../../atendente-v2/wholesale-stock-read.js';
import { releaseMatrizGalpaoReservation } from '../../atendente-v2/matriz-stock-reservation.js';
import { postMatrizRetailCancellation } from './matriz-ledger-retail-sales.js';

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
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const pickup = await client.query<{ updated_at: string }>(
      `SELECT pickup.updated_at
         FROM commerce.orders pickup
         JOIN core.units unit
           ON unit.environment=pickup.environment AND unit.id=pickup.unit_id
        WHERE pickup.environment=$1 AND pickup.id=$2
          AND pickup.partner_order_id IS NULL
          AND pickup.fulfillment_mode='pickup' AND pickup.status='open'
          AND unit.slug='main'
          AND EXISTS (SELECT 1 FROM audit.events reservation
                       WHERE reservation.environment=pickup.environment
                         AND reservation.entity_id=pickup.id
                         AND reservation.event_type='matriz_galpao_reserved')
        FOR UPDATE OF pickup`,
      [environment, input.order_id],
    );
    if (!pickup.rows[0]) throw new Error('pickup_not_found');
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
    await client.query('COMMIT');
    return { cancelled: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
