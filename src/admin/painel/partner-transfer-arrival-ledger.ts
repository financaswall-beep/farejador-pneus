import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import {
  matrizLedgerActor, postMatrizLedgerTransaction,
} from './matriz-ledger-posting.js';
import { moneyCents } from './stage5-integrity.js';
import {
  ensureWholesaleSaleCogs, ensureWholesaleSaleRevenue, getWholesaleSaleLedgerState,
} from './matriz-ledger-wholesale-sales.js';

interface DispatchLedgerState {
  buyer_id: string;
  sold_at: string;
  created_by: string | null;
  dispatched_cogs: string;
}

async function ensureDispatchLedger(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
  expectedCogs: number,
): Promise<void> {
  if (expectedCogs === 0) return;
  const result = await client.query<{ id: string }>(
    `SELECT id FROM finance.matriz_ledger_transactions
      WHERE environment=$1 AND source_id=$2
        AND source_type='commerce.wholesale_order.partner_dispatch'`,
    [environment, orderId],
  );
  if (!result.rows[0]) throw new Error('matrix_partner_dispatch_ledger_missing');
}

export async function postPartnerTransferDispatchLedger(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
  actorLabel: string,
): Promise<string | null> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return null;
  const result = await client.query<DispatchLedgerState>(
    `SELECT o.buyer_id,o.sold_at,o.created_by,
            COALESCE(sum(i.quantity*i.unit_cost),0)::numeric(14,2)::text AS dispatched_cogs
       FROM commerce.wholesale_orders o
       JOIN commerce.wholesale_order_items i
         ON i.environment=o.environment AND i.order_id=o.id
      WHERE o.environment=$1 AND o.id=$2 AND o.partner_transfer_status='in_transit'
      GROUP BY o.id,o.buyer_id,o.sold_at,o.created_by`,
    [environment, orderId],
  );
  const state = result.rows[0];
  if (!state) throw new Error('matrix_partner_dispatch_state_missing');
  const amount = moneyCents(Number(state.dispatched_cogs)) / 100;
  if (amount === 0) return null;
  return postMatrizLedgerTransaction(client, {
    environment,
    sourceType: 'commerce.wholesale_order.partner_dispatch',
    sourceId: orderId,
    kind: 'inventory_in_transit_dispatch',
    amount,
    occurredAt: state.sold_at,
    description: 'Pneus enviados ao parceiro aguardando acerto',
    createdBy: matrizLedgerActor(actorLabel || state.created_by),
    lines: [
      { account_code: 'inventory_in_transit', account_class: 'asset', side: 'debit', amount },
      { account_code: 'inventory', account_class: 'asset', side: 'credit', amount },
    ],
    metadata: { order_id: orderId, buyer_id: state.buyer_id },
  });
}

export async function postPartnerArrivalLedgerAdjustment(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
  actorLabel: string,
  settledAt = new Date().toISOString(),
): Promise<void> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return;
  const result = await client.query<{ dispatched_cogs: string }>(
    `SELECT COALESCE(sum(i.quantity*i.unit_cost)
              FILTER (WHERE i.source_cargo_lot_id IS NULL),0)::numeric(14,2)::text AS dispatched_cogs
       FROM commerce.wholesale_orders o
       JOIN commerce.wholesale_order_items i
         ON i.environment=o.environment AND i.order_id=o.id
      WHERE o.environment=$1 AND o.id=$2
        AND o.status='confirmed' AND o.partner_transfer_status='settled'
      GROUP BY o.id`,
    [environment, orderId],
  );
  const state = result.rows[0];
  if (!state) throw new Error('matrix_partner_arrival_ledger_state_missing');
  await ensureDispatchLedger(client, environment, orderId, Number(state.dispatched_cogs));
  const sale = await getWholesaleSaleLedgerState(client, environment, orderId);
  const recognized = { ...sale, soldAt: settledAt, createdBy: actorLabel };
  await ensureWholesaleSaleRevenue(client, recognized);
  await ensureWholesaleSaleCogs(client, recognized);
}

export async function postCargoReturnLedger(
  client: PoolClient,
  input: {
    environment: 'prod' | 'test'; cargo_lot_id: string; quantity: number;
    unit_cost: string | number; actor_label: string; reason: string;
  },
): Promise<void> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return;
  const amount = moneyCents(input.quantity * Number(input.unit_cost)) / 100;
  if (amount === 0) return;
  await postMatrizLedgerTransaction(client, {
    environment: input.environment,
    sourceType: 'commerce.matrix_partner_cargo.return',
    sourceId: input.cargo_lot_id,
    kind: 'cargo_return_to_matrix',
    amount,
    occurredAt: new Date().toISOString(),
    description: 'Retorno físico da carga recusada ao galpão',
    createdBy: matrizLedgerActor(input.actor_label),
    lines: [
      { account_code: 'inventory', account_class: 'asset', side: 'debit', amount },
      { account_code: 'inventory_in_transit', account_class: 'asset', side: 'credit', amount },
    ],
    metadata: {
      cargo_lot_id: input.cargo_lot_id, quantity: input.quantity, reason: input.reason,
    },
  });
}
