import type { PoolClient } from 'pg';
import { recordIntegrityEvent, type MatrizEnvironment } from './stage5-integrity.js';

export type PurchaseGroupRecordKind = 'purchase' | 'expense';
export interface GroupLinkInput {
  environment: MatrizEnvironment;
  group_id?: string | null;
  record_id: string;
  kind: PurchaseGroupRecordKind;
  actor: string;
  idempotency_key: string;
  unlink?: boolean;
}

/** O chamador é dono da transação. Escreve APENAS vínculo + auditoria. */
export async function linkPurchaseGroupInTransaction(client: PoolClient, input: GroupLinkInput) {
  if (!input.group_id) return;
  const table = input.kind === 'purchase'
    ? 'wholesale_purchase_group_purchases' : 'wholesale_purchase_group_expenses';
  const column = input.kind === 'purchase' ? 'purchase_id' : 'expense_id';
  let changed: number;
  if (input.unlink) {
    changed = (await client.query(`DELETE FROM commerce.${table}
      WHERE environment=$1 AND group_id=$2 AND ${column}=$3`,
    [input.environment, input.group_id, input.record_id])).rowCount ?? 0;
    if (!changed) throw Error('purchase_group_link_not_found');
  } else {
    await client.query(`INSERT INTO commerce.${table}(environment,group_id,${column},linked_by)
      VALUES($1,$2,$3,$4)`, [input.environment, input.group_id, input.record_id, input.actor]);
  }
  await recordIntegrityEvent(client, { environment: input.environment, domain: 'wholesale_purchase_group',
    entityTable: 'commerce.wholesale_purchase_groups', entityId: input.group_id,
    eventType: `${input.kind}_${input.unlink ? 'unlinked' : 'linked'}`, actorLabel: input.actor,
    idempotencyKey: input.idempotency_key, after: { kind: input.kind, record_id: input.record_id } });
}
