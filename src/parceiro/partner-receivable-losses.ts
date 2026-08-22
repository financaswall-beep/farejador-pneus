import { moneyCents } from '../shared/catalog-pricing.js';
import { normalizeBusinessFactInstant } from '../shared/business-time.js';
import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';
import { assertPositiveCentMoney, normalizePartnerText } from './partner-finance-input.js';
import { assertReceivableEventReplay, findReceivableEventReplay } from './partner-receivable-events.js';

export interface WriteOffPartnerReceivableInput {
  occurred_at?: string | null;
  amount?: number | null;
  reason: string;
  idempotency_key: string;
}

export interface RecoverPartnerReceivableInput {
  occurred_at?: string | null;
  amount: number;
  payment_method: string;
  note?: string | null;
  idempotency_key: string;
}

export interface RenegotiatePartnerReceivableInput {
  due_date: string;
  reason: string;
}

export async function writeOffPartnerReceivable(
  ctx: PartnerContext,
  receivableId: string,
  input: WriteOffPartnerReceivableInput,
): Promise<{ receivable_id: string; written_off: boolean; amount: string }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const requestKey = input.idempotency_key.trim();
    const replay = await findReceivableEventReplay(client, ctx, requestKey);
    if (replay) {
      assertReceivableEventReplay(replay, { receivableId,
        eventKind: 'writeoff', amount: input.amount });
      return { receivable_id: receivableId, written_off: true,
        amount: (moneyCents(Number(replay.amount)) / 100).toFixed(2) };
    }
    const occurredAt = normalizeBusinessFactInstant(
      input.occurred_at, new Date(), 'occurred_at_future',
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
    if (openAmount <= 0) return { receivable_id: receivableId, written_off: false, amount: '0.00' };
    const amount = input.amount == null ? openAmount : assertPositiveCentMoney(input.amount);
    if (moneyCents(amount) > moneyCents(openAmount)) throw new Error('receivable_writeoff_exceeds_balance');
    await client.query(
      `INSERT INTO finance.partner_receivable_events (
         environment,unit_id,receivable_id,event_kind,amount,occurred_at,
         reason,idempotency_key,created_by
       ) VALUES ($1,$2,$3,'writeoff',$4,$5::timestamptz,$6,$7,$8)
       ON CONFLICT (environment,idempotency_key) DO UPDATE
         SET idempotency_key=EXCLUDED.idempotency_key`,
      [ctx.environment, ctx.unitId, receivableId, amount, occurredAt,
       input.reason.trim(), requestKey, `partner:${ctx.slug}`],
    );
    await client.query(
      `INSERT INTO audit.events (environment,domain,entity_table,entity_id,
         event_type,actor_label,idempotency_key,payload_after)
       VALUES ($1,'partner_finance','finance.partner_receivables',$2,
         'partner_receivable_written_off',$3,$4,$5::jsonb)`,
      [ctx.environment, receivableId, `partner:${ctx.slug}`, input.idempotency_key,
       JSON.stringify({ unit_id: ctx.unitId, amount, occurred_at: occurredAt,
         reason: input.reason.trim() })],
    );
    return { receivable_id: receivableId, written_off: true,
      amount: (moneyCents(amount) / 100).toFixed(2) };
  });
}

export async function recoverPartnerReceivable(
  ctx: PartnerContext,
  receivableId: string,
  input: RecoverPartnerReceivableInput,
): Promise<{ receivable_id: string; recovered: boolean; amount: string }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const amount = assertPositiveCentMoney(input.amount);
    const requestKey = input.idempotency_key.trim();
    const replay = await findReceivableEventReplay(client, ctx, requestKey);
    if (replay) {
      assertReceivableEventReplay(replay, { receivableId,
        eventKind: 'recovery', amount });
      return { receivable_id: receivableId, recovered: true,
        amount: (moneyCents(Number(replay.amount)) / 100).toFixed(2) };
    }
    const occurredAt = normalizeBusinessFactInstant(
      input.occurred_at, new Date(), 'occurred_at_future',
    ) ?? new Date().toISOString();
    const target = await client.query(
      `SELECT id FROM finance.partner_receivables
        WHERE id=$1 AND environment=$2 AND unit_id=$3
          AND status IN ('written_off','resolved') AND deleted_at IS NULL
        FOR UPDATE`,
      [receivableId, ctx.environment, ctx.unitId],
    );
    if (!target.rows[0]) return { receivable_id: receivableId, recovered: false, amount: '0.00' };
    await client.query(
      `INSERT INTO finance.partner_receivable_events (
         environment,unit_id,receivable_id,event_kind,amount,occurred_at,
         payment_method,reason,idempotency_key,created_by
       ) VALUES ($1,$2,$3,'recovery',$4,$5::timestamptz,$6,$7,$8,$9)
       ON CONFLICT (environment,idempotency_key) DO UPDATE
         SET idempotency_key=EXCLUDED.idempotency_key`,
      [ctx.environment, ctx.unitId, receivableId, amount, occurredAt,
       input.payment_method.trim(), normalizePartnerText(input.note),
       requestKey, `partner:${ctx.slug}`],
    );
    return { receivable_id: receivableId, recovered: true,
      amount: (moneyCents(amount) / 100).toFixed(2) };
  });
}

export async function renegotiatePartnerReceivable(
  ctx: PartnerContext,
  receivableId: string,
  input: RenegotiatePartnerReceivableInput,
): Promise<{ receivable_id: string; renegotiated: boolean }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    await client.query(`SELECT set_config('app.partner_receivable_operation','on',true)`);
    const result = await client.query(
      `UPDATE finance.partner_receivables SET due_date=$4::date
        WHERE id=$1 AND environment=$2 AND unit_id=$3
          AND status='open' AND deleted_at IS NULL RETURNING id`,
      [receivableId, ctx.environment, ctx.unitId, input.due_date],
    );
    if (!result.rows[0]) return { receivable_id: receivableId, renegotiated: false };
    await client.query(
      `INSERT INTO audit.events (environment,domain,entity_table,entity_id,
         event_type,actor_label,payload_after)
       VALUES ($1,'partner_finance','finance.partner_receivables',$2,
         'partner_receivable_renegotiated',$3,$4::jsonb)`,
      [ctx.environment, receivableId, `partner:${ctx.slug}`,
       JSON.stringify({ unit_id: ctx.unitId, due_date: input.due_date,
         reason: input.reason.trim() })],
    );
    return { receivable_id: receivableId, renegotiated: true };
  });
}
