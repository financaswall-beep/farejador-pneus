import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { getClientesPainelV2 } from './queries-clientes-v2.js';

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}

const headers = ['identity_id','entity_type','classification','vip','name','phone','email','document_number',
  'scope','source_types','conflicts','purchases','total_spent','avg_ticket','gross_profit',
  'pending_cost_items','first_purchase_at','last_purchase_at','created_at'];

export async function* streamCustomerCsv(
  environment: 'prod' | 'test', filter: string | undefined, dbPool: Pool = defaultPool,
): AsyncGenerator<string> {
  yield `\uFEFF${headers.map(csvCell).join(',')}\r\n`;
  let cursor: string | undefined;
  do {
    const page = await getClientesPainelV2({ cursor,limit:200,filter },environment,dbPool);
    for (const row of page.rows) {
      yield [row.id,row.entity_type,row.classification,row.is_vip,row.name,row.phone,row.email,
        row.document_number,row.scope,row.sources.map((source) => source.source_type).join(';'),
        row.conflicts.join(';'),row.metrics.purchases,row.metrics.total_spent,row.metrics.avg_ticket,
        row.metrics.gross_profit,row.metrics.pending_cost_items,row.metrics.first_purchase_at,
        row.metrics.last_purchase_at,row.created_at].map(csvCell).join(',')+'\r\n';
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
}

export async function auditCustomerExport(
  environment: 'prod' | 'test', actor: string, reason: string, hasFilter: boolean,
  dbPool: Pool = defaultPool,
): Promise<void> {
  if (reason.trim().length < 5) throw new Error('reason_required');
  await dbPool.query(
    `INSERT INTO audit.events(environment,domain,entity_table,event_type,actor_label,payload_after)
     VALUES($1,'customer_identity','commerce.customer_identities','customer_identity_pii_export',$2,$3::jsonb)`,
    [environment,actor,JSON.stringify({ reason_recorded:true,filter_applied:hasFilter,format:'csv',streamed:true })]);
}
