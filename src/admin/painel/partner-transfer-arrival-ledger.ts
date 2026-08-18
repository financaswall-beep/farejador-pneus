import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import {
  matrizLedgerActor, postMatrizLedgerTransaction,
} from './matriz-ledger-posting.js';
import { moneyCents } from './stage5-integrity.js';

interface ArrivalLedgerState {
  buyer_id: string;
  payment_status: 'paid' | 'pending';
  sold_at: string;
  dispatched_total: string;
  settled_total: string;
  dispatched_cogs: string;
  settled_cogs: string;
}

function amountDelta(finalValue: string, initialValue: string): number {
  return (moneyCents(Number(finalValue)) - moneyCents(Number(initialValue))) / 100;
}

async function ensureOriginalLedger(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
  expectedRevenue: number,
  expectedCogs: number,
): Promise<void> {
  const result = await client.query<{ source_type: string }>(
    `SELECT source_type FROM finance.matriz_ledger_transactions
      WHERE environment=$1 AND source_id=$2
        AND source_type IN ('commerce.wholesale_order.revenue','commerce.wholesale_order.cogs')`,
    [environment, orderId],
  );
  const sources = new Set(result.rows.map((row) => row.source_type));
  if ((expectedRevenue !== 0 && !sources.has('commerce.wholesale_order.revenue'))
      || (expectedCogs !== 0 && !sources.has('commerce.wholesale_order.cogs'))) {
    throw new Error('matrix_partner_original_ledger_missing');
  }
}

export async function postPartnerArrivalLedgerAdjustment(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
  actorLabel: string,
): Promise<void> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return;
  const result = await client.query<ArrivalLedgerState>(
    `SELECT o.buyer_id,o.payment_status,o.sold_at,
            o.dispatched_total_amount::text AS dispatched_total,
            o.settled_total_amount::text AS settled_total,
            COALESCE(sum(i.quantity*i.unit_cost)
              FILTER (WHERE i.source_cargo_lot_id IS NULL),0)::numeric(14,2)::text AS dispatched_cogs,
            COALESCE(sum(COALESCE(i.accepted_quantity,0)*i.unit_cost),0)::numeric(14,2)::text AS settled_cogs
       FROM commerce.wholesale_orders o
       JOIN commerce.wholesale_order_items i
         ON i.environment=o.environment AND i.order_id=o.id
      WHERE o.environment=$1 AND o.id=$2
      GROUP BY o.id,o.buyer_id,o.payment_status,o.sold_at,
               o.dispatched_total_amount,o.settled_total_amount`,
    [environment, orderId],
  );
  const state = result.rows[0];
  if (!state) throw new Error('matrix_partner_arrival_ledger_state_missing');
  await ensureOriginalLedger(
    client, environment, orderId,
    Number(state.dispatched_total), Number(state.dispatched_cogs),
  );

  const revenueDelta = amountDelta(state.settled_total, state.dispatched_total);
  if (revenueDelta !== 0) {
    const increase = revenueDelta > 0;
    const amount = Math.abs(revenueDelta);
    const adjustedAt = new Date().toISOString();
    const counterpart = state.payment_status === 'pending' ? 'accounts_receivable' : 'cash';
    await postMatrizLedgerTransaction(client, {
      environment,
      sourceType: `commerce.wholesale_order.arrival_revenue_${increase ? 'increase' : 'decrease'}`,
      sourceId: orderId,
      kind: increase ? 'arrival_extra_sale' : 'arrival_refusal_credit',
      amount,
      occurredAt: adjustedAt,
      cashAt: state.payment_status === 'paid' ? adjustedAt : null,
      description: increase
        ? 'Pneus adicionais aceitos na chegada'
        : 'Crédito dos pneus recusados na chegada',
      createdBy: matrizLedgerActor(actorLabel),
      lines: increase ? [
        { account_code: counterpart, account_class: 'asset', side: 'debit', amount },
        { account_code: 'sales_revenue', account_class: 'revenue', side: 'credit', amount },
      ] : [
        { account_code: 'sales_returns', account_class: 'revenue', side: 'debit', amount },
        { account_code: counterpart, account_class: 'asset', side: 'credit', amount },
      ],
      metadata: {
        order_id: orderId, buyer_id: state.buyer_id,
        dispatched_total: state.dispatched_total, settled_total: state.settled_total,
      },
    });
  }

  const cogsDelta = amountDelta(state.settled_cogs, state.dispatched_cogs);
  if (cogsDelta !== 0) {
    const consumedFromCargo = cogsDelta > 0;
    const amount = Math.abs(cogsDelta);
    await postMatrizLedgerTransaction(client, {
      environment,
      sourceType: `commerce.wholesale_order.arrival_cogs_${consumedFromCargo ? 'increase' : 'decrease'}`,
      sourceId: orderId,
      kind: consumedFromCargo ? 'cargo_allocated_cogs' : 'cargo_refusal_recovery',
      amount,
      occurredAt: new Date().toISOString(),
      description: consumedFromCargo
        ? 'Custo da carga redirecionada ao parceiro'
        : 'Custo dos pneus recusados mantido em trânsito',
      createdBy: matrizLedgerActor(actorLabel),
      lines: consumedFromCargo ? [
        { account_code: 'cost_of_goods_sold', account_class: 'expense', side: 'debit', amount },
        { account_code: 'inventory_in_transit', account_class: 'asset', side: 'credit', amount },
      ] : [
        { account_code: 'inventory_in_transit', account_class: 'asset', side: 'debit', amount },
        { account_code: 'cost_of_goods_sold', account_class: 'expense', side: 'credit', amount },
      ],
      metadata: {
        order_id: orderId, buyer_id: state.buyer_id,
        dispatched_cogs: state.dispatched_cogs, settled_cogs: state.settled_cogs,
      },
    });
  }
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
