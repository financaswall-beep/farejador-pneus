import type { Pool } from 'pg';
import { organicPublicationWindow } from '../../admin/painel/marketing-organic-period.js';

type Period = ReturnType<typeof organicPublicationWindow>;
type Row = Record<string, any>;
const date = (value: any) => new Date(value).toISOString();
const day = (value: any) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date(value));
const money = (value: number) => Math.round(value * 100) / 100;
function within(value: any, period: Period) { return value && day(value) >= period.since && day(value) <= period.until; }
function series(values: any[], period: Period, key: string, now: Date) {
  const counts = new Map<string, number>();
  for (const value of values) { const d = day(value); counts.set(d, (counts.get(d) ?? 0) + 1); }
  const rows: Row[] = [];
  let cumulative = 0;
  for (let d = period.since; d <= period.until && d <= day(now);) {
    cumulative += counts.get(d) ?? 0;
    rows.push({ date: d, [key]: cumulative });
    d = new Date(Date.parse(d + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  }
  return rows;
}

/** Contagens de pessoas/conversas nunca usam o número de pedidos como denominador. */
export function buildOrganicReport(period: Period, outreach: Row[], sources: Row[], orders: Row[], now = new Date()) {
  const sent = outreach.filter(o => o.status === 'sent' && within(o.sent_at, period));
  const sentIds = new Set(sent.map(o => o.id));
  const replies = sources.filter(s => sentIds.has(s.outreach_id) && within(s.first_reply_at, period));
  const sourceIds = new Set(replies.map(s => s.id));
  const conversations = new Map<string, any>();
  for (const s of replies) {
    const earlier = conversations.get(s.conversation_id);
    if (!earlier || new Date(s.first_reply_at) < new Date(earlier)) conversations.set(s.conversation_id, s.first_reply_at);
  }
  const unique = [...new Map(orders.filter(o => sourceIds.has(o.conversation_source_id)).map(o => [o.order_id, o])).values()];
  const confirmed = unique.filter(o => !o.cancelled && within(o.confirmed_at, period));
  const completed = unique.filter(o => !o.cancelled && o.realized_at && within(o.realized_at, period));
  const salesRows = unique.filter(o => within(o.cancelled ? o.updated_at : o.realized_at, period)).map(o => ({
    order_id: o.order_id, order_number: String(o.order_number), customer_name: o.customer_name || 'Cliente',
    source_confirmed: true, status: o.cancelled ? 'cancelled' : 'completed',
    amount: money(Math.max(0, Number(o.amount) - Number(o.refunded || 0))),
    confirmed_at: date(o.confirmed_at), completed_at: o.cancelled ? null : date(o.realized_at),
    cancelled_at: o.cancelled ? date(o.updated_at) : null,
    origin: { comment_text: o.comment_text, commented_at: date(o.commented_at), comment_url: null,
      private_sent_at: date(o.private_sent_at), first_reply_at: date(o.first_reply_at), conversation_id: String(o.chatwoot_conversation_id) },
  }));
  const durations = confirmed.map(o => (new Date(o.confirmed_at).getTime() - new Date(o.first_reply_at).getTime()) / 60000)
    .filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const buckets: [number,number,number,number] = [0, 0, 0, 0];
  for (const n of durations) buckets[n <= 60 ? 0 : n <= 720 ? 1 : n <= 1440 ? 2 : 3]++;
  const failures = outreach.filter(o => ['failed', 'uncertain'].includes(o.status) && within(o.created_at, period));
  return {
    status: 'ready', period, attribution_window_days: 7, private_messages: sent.length,
    conversations: conversations.size, converted_conversations: new Set(completed.map(o => o.conversation_id)).size,
    sales: completed.length, revenue: money(completed.reduce((sum, o) => sum + Math.max(0, Number(o.amount) - Number(o.refunded || 0)), 0)),
    confirmed_orders: confirmed.length, median_confirmation_minutes: durations.length
      ? (durations[Math.floor((durations.length - 1) / 2)]! + durations[Math.floor(durations.length / 2)]!) / 2 : null,
    confirmation_time_buckets: buckets,
    sales_series: series(completed.map(o => o.realized_at), period, 'sales', now),
    conversation_series: series([...conversations.values()], period, 'conversations', now),
    sales_rows: salesRows, sales_rows_complete: true,
    private_replied: new Set(replies.map(s => s.outreach_id)).size, private_failed: failures.length,
    private_failures: failures.map(o => ({ id: o.id, occurred_at: date(o.created_at),
      message: o.status === 'uncertain' ? 'Envio sem confirmação. Não será repetido automaticamente.' : 'A plataforma recusou o envio privado.' })),
  };
}

export async function organicAttributionReport(pool: Pool, environment: string, platform: string, account: string,
  postId: string, publishedAt: string, window: '7d' | '30d') {
  const period = organicPublicationWindow(publishedAt, window);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='8s'");
    const args = [environment, platform, account, postId];
    const outreach = await client.query(`SELECT o.* FROM ops.organic_outreach o JOIN core.meta_comments c
      ON c.environment=o.environment AND c.id=o.comment_id
      WHERE c.environment=$1 AND c.platform=$2 AND c.account_id=$3 AND c.post_id=$4 LIMIT 10001`, args);
    const sources = await client.query(`SELECT s.* FROM analytics.organic_conversation_sources s
      JOIN ops.organic_outreach o ON o.environment=s.environment AND o.id=s.outreach_id
      JOIN core.meta_comments c ON c.environment=o.environment AND c.id=o.comment_id
      JOIN core.conversations cv ON cv.environment=s.environment AND cv.id=s.conversation_id
      WHERE c.environment=$1 AND c.platform=$2 AND c.account_id=$3 AND c.post_id=$4
        AND s.superseded_by IS NULL AND cv.deleted_at IS NULL
        AND COALESCE(cv.additional_attributes->>'farejador_simulator','false')<>'true' LIMIT 10001`, args);
    const orders = await client.query(`SELECT os.order_id,os.conversation_source_id,os.confirmed_at,
        s.conversation_id,s.first_reply_at,cv.chatwoot_conversation_id,c.body comment_text,c.occurred_at commented_at,
        out.sent_at private_sent_at,o.order_number,o.customer_name,o.updated_at,
        COALESCE(po.total_amount,o.total_amount) amount,COALESCE(ref.amount,0) refunded,
        (o.status='cancelled' OR po.status='cancelled' OR po.deleted_at IS NOT NULL) cancelled,
        CASE WHEN o.partner_order_id IS NOT NULL THEN
          CASE WHEN po.deleted_at IS NULL AND po.status IN ('confirmed','paid','delivered') AND NOT po.awaiting_pickup
            AND (po.fulfillment_mode<>'delivery' OR po.delivery_status='delivered')
            THEN CASE WHEN po.fulfillment_mode='delivery' THEN po.delivered_at ELSE COALESCE(po.retrieved_at,po.created_at) END END
          ELSE CASE WHEN o.status IN ('confirmed','paid','delivered')
            AND (o.fulfillment_mode<>'delivery' OR o.delivery_status='delivered')
            THEN CASE WHEN o.fulfillment_mode='delivery' THEN o.delivered_at ELSE COALESCE(o.retrieved_at,o.created_at) END END
        END realized_at
      FROM analytics.organic_order_sources os JOIN commerce.orders o ON o.environment=os.environment AND o.id=os.order_id
      JOIN analytics.organic_conversation_sources s ON s.environment=os.environment AND s.id=os.conversation_source_id AND s.superseded_by IS NULL
      JOIN core.conversations cv ON cv.environment=s.environment AND cv.id=s.conversation_id AND cv.deleted_at IS NULL
      JOIN ops.organic_outreach out ON out.environment=s.environment AND out.id=s.outreach_id
      JOIN core.meta_comments c ON c.environment=out.environment AND c.id=out.comment_id
      LEFT JOIN commerce.partner_orders po ON po.environment=o.environment AND po.id=o.partner_order_id
      LEFT JOIN finance.partner_order_refunds ref ON ref.environment=po.environment AND ref.order_id=po.id
      WHERE os.superseded_by IS NULL AND c.environment=$1 AND c.platform=$2 AND c.account_id=$3 AND c.post_id=$4
        AND COALESCE(cv.additional_attributes->>'farejador_simulator','false')<>'true' LIMIT 10001`, args);
    await client.query('COMMIT');
    if ([outreach, sources, orders].some(r => r.rows.length > 10000)) return { status: 'too_large', period };
    return buildOrganicReport(period, outreach.rows, sources.rows, orders.rows);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
