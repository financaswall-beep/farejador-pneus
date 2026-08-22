import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { moneyCents } from '../shared/catalog-pricing.js';
import { normalizeBusinessFactInstant } from '../shared/business-time.js';
import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';
import { assertPositiveCentMoney } from './partner-finance-input.js';

export interface SettlePartnerReceivableInstallmentInput {
  received_at?: string | null;
  payment_method?: string | null;
  amount?: number | null;
  idempotency_key?: string | null;
}

export interface SettlePartnerReceivableInput {
  received_at?: string | null;
  payment_method?: string | null;
  amount?: number | null;
  idempotency_key?: string | null;
}

export interface ReceivableEventReplayRow {
  receivable_id: string;
  installment_id: string | null;
  event_kind: 'receipt' | 'writeoff' | 'recovery' | 'refund';
  amount: string;
}

export async function findReceivableEventReplay(
  client: PoolClient,
  ctx: PartnerContext,
  idempotencyKey: string | null,
): Promise<ReceivableEventReplayRow | null> {
  if (!idempotencyKey) return null;
  const result = await client.query<ReceivableEventReplayRow>(
    `SELECT receivable_id,installment_id,event_kind,amount::text
       FROM finance.partner_receivable_events
      WHERE environment=$1 AND unit_id=$2 AND idempotency_key=$3`,
    [ctx.environment, ctx.unitId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

export function assertReceivableEventReplay(
  replay: ReceivableEventReplayRow,
  expected: { receivableId: string; installmentId?: string | null;
    eventKind: ReceivableEventReplayRow['event_kind']; amount?: number | null },
): void {
  const sameAmount = expected.amount == null
    || moneyCents(Number(replay.amount)) === moneyCents(expected.amount);
  if (replay.receivable_id !== expected.receivableId
      || replay.installment_id !== (expected.installmentId ?? null)
      || replay.event_kind !== expected.eventKind || !sameAmount) {
    throw new Error('partner_finance_idempotency_conflict');
  }
}

export async function settlePartnerReceivableInstallment(
  ctx: PartnerContext,
  receivableId: string,
  installmentId: string,
  input: SettlePartnerReceivableInstallmentInput,
): Promise<{ installment_id: string; received: boolean }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const requestKey = input.idempotency_key?.trim() || null;
    const replay = await findReceivableEventReplay(client, ctx, requestKey);
    if (replay) {
      assertReceivableEventReplay(replay, { receivableId, installmentId,
        eventKind: 'receipt', amount: input.amount });
      return { installment_id: installmentId, received: true };
    }
    const receivedAt = normalizeBusinessFactInstant(
      input.received_at, new Date(), 'received_at_future',
    ) ?? new Date().toISOString();
    const target = await client.query<{ open_amount: string }>(
      `SELECT GREATEST(i.amount-COALESCE((SELECT sum(e.amount)
          FROM finance.partner_receivable_events e
         WHERE e.environment=i.environment AND e.receivable_id=i.receivable_id
           AND e.installment_id=i.id AND e.event_kind IN ('receipt','writeoff')),0),0)::text
          AS open_amount
         FROM finance.partner_receivable_installments i
         JOIN finance.partner_receivables r
           ON r.environment=i.environment AND r.id=i.receivable_id
        WHERE i.environment=$1 AND r.unit_id=$2
          AND i.receivable_id=$3 AND i.id=$4
          AND i.deleted_at IS NULL AND r.deleted_at IS NULL
        FOR UPDATE OF i`,
      [ctx.environment, ctx.unitId, receivableId, installmentId],
    );
    const openAmount = Number(target.rows[0]?.open_amount ?? 0);
    if (openAmount <= 0) return { installment_id: installmentId, received: false };
    const amount = input.amount == null ? openAmount : assertPositiveCentMoney(input.amount);
    if (moneyCents(amount) > moneyCents(openAmount)) throw new Error('receivable_payment_exceeds_balance');
    const result = await client.query<{ id: string }>(
      `INSERT INTO finance.partner_receivable_events (
         environment,unit_id,receivable_id,installment_id,event_kind,amount,
         occurred_at,payment_method,idempotency_key,created_by
       ) VALUES ($1,$2,$3,$4,'receipt',$5,$6::timestamptz,$7,$8,$9)
       ON CONFLICT (environment,idempotency_key) DO UPDATE
         SET idempotency_key=EXCLUDED.idempotency_key
       RETURNING id`,
      [ctx.environment, ctx.unitId, receivableId, installmentId, amount, receivedAt,
       input.payment_method?.trim() || 'Pix',
       requestKey || `installment:${installmentId}:receipt:${randomBytes(8).toString('hex')}`,
       `partner:${ctx.slug}`],
    );
    if (result.rowCount !== 1) return { installment_id: installmentId, received: false };
    await client.query(
      `INSERT INTO audit.events (
         environment, domain, entity_table, entity_id, event_type,
         actor_label, payload_after
       ) VALUES ($1, 'partner_finance', 'finance.partner_receivable_installments', $2,
                 'partner_receivable_installment_received', $3, $4::jsonb)`,
      [ctx.environment, installmentId, `partner:${ctx.slug}`,
       JSON.stringify({ unit_id: ctx.unitId, receivable_id: receivableId,
         received_at: receivedAt, amount })],
    );
    return { installment_id: installmentId, received: true };
  });
}

export async function settlePartnerReceivable(
  ctx: PartnerContext,
  receivableId: string,
  input: SettlePartnerReceivableInput,
): Promise<{ receivable_id: string; received: boolean }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const requestKey = input.idempotency_key?.trim() || null;
    const replay = await findReceivableEventReplay(client, ctx, requestKey);
    if (replay) {
      assertReceivableEventReplay(replay, { receivableId,
        eventKind: 'receipt', amount: input.amount });
      return { receivable_id: receivableId, received: true };
    }
    const receivedAt = normalizeBusinessFactInstant(
      input.received_at, new Date(), 'received_at_future',
    ) ?? new Date().toISOString();
    const target = await client.query<{ open_amount: string }>(
      `SELECT GREATEST(r.amount-COALESCE((SELECT sum(e.amount)
          FROM finance.partner_receivable_events e
         WHERE e.environment=r.environment AND e.receivable_id=r.id
           AND e.installment_id IS NULL
           AND e.event_kind IN ('receipt','writeoff')),0),0)::text open_amount
         FROM finance.partner_receivables r
        WHERE r.id=$1 AND r.environment=$2 AND r.unit_id=$3
          AND r.status='open' AND r.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM finance.partner_receivable_installments i
            WHERE i.environment=r.environment AND i.receivable_id=r.id
              AND i.deleted_at IS NULL)
        FOR UPDATE OF r`,
      [receivableId, ctx.environment, ctx.unitId],
    );
    const openAmount = Number(target.rows[0]?.open_amount ?? 0);
    if (openAmount <= 0) return { receivable_id: receivableId, received: false };
    const amount = input.amount == null ? openAmount : assertPositiveCentMoney(input.amount);
    if (moneyCents(amount) > moneyCents(openAmount)) throw new Error('receivable_payment_exceeds_balance');
    await client.query(
      `INSERT INTO finance.partner_receivable_events (
         environment,unit_id,receivable_id,event_kind,amount,occurred_at,
         payment_method,idempotency_key,created_by
       ) VALUES ($1,$2,$3,'receipt',$4,$5::timestamptz,$6,$7,$8)
       ON CONFLICT (environment,idempotency_key) DO UPDATE
         SET idempotency_key=EXCLUDED.idempotency_key`,
      [ctx.environment, ctx.unitId, receivableId, amount, receivedAt,
       input.payment_method?.trim() || 'Pix',
       requestKey || `receivable:${receivableId}:receipt:${randomBytes(8).toString('hex')}`,
       `partner:${ctx.slug}`],
    );
    await client.query(
      `INSERT INTO audit.events (
         environment, domain, entity_table, entity_id, event_type,
         actor_label, payload_after
       ) VALUES ($1, 'partner_finance', 'finance.partner_receivables', $2,
                 'partner_receivable_received', $3, $4::jsonb)`,
      [ctx.environment, receivableId, `partner:${ctx.slug}`,
       JSON.stringify({ unit_id: ctx.unitId, received_at: receivedAt, amount })],
    );
    return { receivable_id: receivableId, received: true };
  });
}
