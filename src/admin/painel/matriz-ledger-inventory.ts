import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import {
  matrizLedgerActor, matrizLedgerAmount, postMatrizLedgerTransaction,
  type MatrizLedgerLine,
} from './matriz-ledger-posting.js';

interface MatrizInventoryAdjustment {
  id: string;
  environment: 'prod' | 'test';
  stock_movement_id: string;
  measure: string;
  direction: 'gain' | 'loss';
  nature: string;
  quantity_delta: number;
  amount: string;
  source: string;
  reason: string | null;
  movement_ref: string | null;
  occurred_at: string;
}

function adjustmentLines(
  adjustment: MatrizInventoryAdjustment,
  amount: number,
): MatrizLedgerLine[] {
  if (adjustment.direction === 'gain') {
    const credit = adjustment.nature === 'owner_contribution'
      ? { account_code: 'owner_equity', account_class: 'equity' as const }
      : adjustment.nature === 'opening_balance'
        ? { account_code: 'opening_equity', account_class: 'equity' as const }
        : { account_code: 'inventory_gain', account_class: 'revenue' as const };
    return [
      { account_code: 'inventory', account_class: 'asset', side: 'debit', amount },
      { ...credit, side: 'credit', amount },
    ];
  }

  const debit = adjustment.nature === 'internal_use'
    ? 'inventory_internal_use'
    : 'inventory_loss';
  return [
    { account_code: debit, account_class: 'expense', side: 'debit', amount },
    { account_code: 'inventory', account_class: 'asset', side: 'credit', amount },
  ];
}

export async function ensureMatrizInventoryAdjustmentPosting(
  client: PoolClient,
  adjustment: MatrizInventoryAdjustment,
  actorLabel?: string | null,
): Promise<string | null> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return null;
  const amount = matrizLedgerAmount(adjustment.amount, 'inventory_ledger_amount_invalid');
  if (amount === 0) return null;
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM finance.matriz_ledger_transactions
      WHERE environment=$1
        AND source_type='finance.inventory_adjustment'
        AND source_id=$2`,
    [adjustment.environment, adjustment.id],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  return postMatrizLedgerTransaction(client, {
    environment: adjustment.environment,
    sourceType: 'finance.inventory_adjustment',
    sourceId: adjustment.id,
    kind: adjustment.direction === 'gain' ? 'inventory_gain' : 'inventory_loss',
    amount,
    occurredAt: adjustment.occurred_at,
    description: adjustment.reason ?? `Ajuste de estoque: ${adjustment.measure}`,
    createdBy: matrizLedgerActor(actorLabel),
    lines: adjustmentLines(adjustment, amount),
    metadata: {
      stock_movement_id: adjustment.stock_movement_id,
      measure: adjustment.measure,
      direction: adjustment.direction,
      nature: adjustment.nature,
      quantity_delta: adjustment.quantity_delta,
      source: adjustment.source,
      movement_ref: adjustment.movement_ref,
    },
  });
}

export async function postMatrizInventoryAdjustmentsByMovementRef(
  client: PoolClient,
  environment: 'prod' | 'test',
  movementRef: string,
  actorLabel?: string | null,
): Promise<string[]> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return [];
  const result = await client.query<MatrizInventoryAdjustment>(
    `SELECT id,environment,stock_movement_id,measure,direction,nature,
            quantity_delta,amount,source,reason,movement_ref,occurred_at::text
       FROM finance.matriz_inventory_adjustments
      WHERE environment=$1 AND movement_ref=$2
      ORDER BY occurred_at,id`,
    [environment, movementRef],
  );
  const posted: string[] = [];
  for (const adjustment of result.rows) {
    const transactionId = await ensureMatrizInventoryAdjustmentPosting(
      client, adjustment, actorLabel,
    );
    if (transactionId) posted.push(transactionId);
  }
  return posted;
}

export async function backfillMatrizInventoryAdjustmentPostings(
  client: PoolClient,
  environment: 'prod' | 'test',
  limit = 500,
): Promise<number> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return 0;
  const result = await client.query<MatrizInventoryAdjustment>(
    `SELECT a.id,a.environment,a.stock_movement_id,a.measure,a.direction,a.nature,
            a.quantity_delta,a.amount,a.source,a.reason,a.movement_ref,a.occurred_at::text
       FROM finance.matriz_inventory_adjustments a
      WHERE a.environment=$1
        AND NOT EXISTS (
          SELECT 1 FROM finance.matriz_ledger_transactions t
           WHERE t.environment=a.environment
             AND t.source_type='finance.inventory_adjustment'
             AND t.source_id=a.id::text
        )
      ORDER BY a.occurred_at,a.id
      LIMIT $2
      FOR UPDATE OF a SKIP LOCKED`,
    [environment, Math.min(Math.max(1, limit), 5_000)],
  );
  for (const adjustment of result.rows) {
    await ensureMatrizInventoryAdjustmentPosting(
      client, adjustment, 'system:inventory-backfill',
    );
  }
  return result.rowCount ?? 0;
}
