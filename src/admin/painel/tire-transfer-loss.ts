import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import { ensureMatrizInventoryAdjustmentPosting } from './matriz-ledger-inventory.js';
import type { Snapshot } from './tire-transfer-plan.js';

export async function postLotLoss(client: PoolClient, environment: 'prod' | 'test',
  transferId: string, movementId: string, before: Snapshot, after: Snapshot,
  cost: string, quantity: number, actor: string, reason: string, reversalOf?: string) {
  if (Number(cost) === 0) return;
  if (!env.MATRIZ_CENTRAL_LEDGER) throw Error('transfer_loss_finance_required');
  const result = await client.query(`INSERT INTO finance.matriz_inventory_adjustments
    (environment,lot_movement_id,measure,direction,nature,quantity_delta,
     value_before,value_after,amount,source,reason,movement_ref,occurred_at)
    VALUES ($1,$2,$3,$4,'loss',$5,$6,$7,$8,'triagem_lote',$9,$10,now()) RETURNING *`,
  [environment, movementId, 'Lote: ' + before.description, reversalOf ? 'gain' : 'loss',
    reversalOf ? quantity : -quantity, before.remaining_cost, after.remaining_cost, cost, reason, transferId]);
  const adjustment = result.rows[0];
  if (!reversalOf) {
    await ensureMatrizInventoryAdjustmentPosting(client, adjustment, actor); return;
  }
  const original = await client.query(`SELECT t.id FROM finance.matriz_ledger_transactions t
    JOIN finance.matriz_inventory_adjustments a ON a.environment=t.environment AND a.id::text=t.source_id
    WHERE a.environment=$1 AND a.movement_ref=$2 AND t.source_type='finance.inventory_adjustment'`,
  [environment, reversalOf]);
  if (original.rowCount !== 1) throw Error('transfer_loss_history_missing');
  await client.query(`SELECT finance.reverse_matriz_ledger_transaction($1::env_t,$2,
    'finance.inventory_adjustment',$3,(now() AT TIME ZONE 'America/Sao_Paulo')::date,
    $4,$5,NULL,$6::jsonb)`, [environment, original.rows[0].id, adjustment.id,
    'Estorno de perda na triagem: ' + reason, actor, JSON.stringify({ transfer_id: transferId, reversal_of: reversalOf })]);
}
