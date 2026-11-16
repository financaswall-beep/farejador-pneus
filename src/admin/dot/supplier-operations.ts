import type { PoolClient } from 'pg';
import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { archiveWholesaleSupplier } from '../painel/queries-fornecedores-cancel.js';
import { registerWholesaleSupplier, updateWholesaleSupplier } from '../painel/queries-fornecedores.js';
import { registerWholesalePurchaseOnClient } from '../painel/register-wholesale-purchase.js';
import { registerLotPurchaseSchema } from '../painel/route-schemas-lot-purchases.js';
import { registerPurchaseFields, registerPurchaseSchema, registerSupplierSchema } from '../painel/route-schemas-purchases.js';
import { recordIntegrityEvent } from '../painel/stage5-integrity.js';
import { id } from './finance-operations.js';

const phone = z.string().trim().min(1).max(40).refine(value => Boolean(normalizeBrazilianPhone(value)), 'telefone_invalido');
const supplierFields = registerSupplierSchema.extend({
  name: z.string().trim().min(1).max(200),
  phone: phone.nullable().optional(),
}).strict();

export const createSupplierInput = supplierFields.extend({ idempotency_key: id });
export const editSupplierInput = z.object({
  supplier_id: id,
  changes: supplierFields.partial().refine(fields => Object.keys(fields).length > 0, 'informe_campos_para_editar'),
  idempotency_key: id,
}).strict();
export const archiveSupplierInput = z.object({ supplier_id: id, idempotency_key: id }).strict();

async function auditSupplier(client: PoolClient, supplierId: string, actor: string, key: string,
  event: 'created' | 'edited' | 'archived', fields?: string[]) {
  await recordIntegrityEvent(client, {
    environment: env.FAREJADOR_ENV, domain: 'wholesale_supplier', entityTable: 'commerce.wholesale_suppliers',
    entityId: supplierId, actorLabel: actor, eventType: event, idempotencyKey: key,
    after: fields ? { fields } : undefined,
  });
}

export async function createSupplier(client: PoolClient, data: z.infer<typeof createSupplierInput>, actor: string) {
  const { idempotency_key, ...fields } = data;
  const supplier = await registerWholesaleSupplier(fields, client);
  await auditSupplier(client, supplier.id, actor, idempotency_key, 'created');
  return { supplier_id: supplier.id, name: supplier.name };
}

export async function editSupplier(client: PoolClient, data: z.infer<typeof editSupplierInput>, actor: string) {
  const supplier = await updateWholesaleSupplier(data.supplier_id, data.changes, env.FAREJADOR_ENV, client);
  const fields = Object.keys(data.changes);
  await auditSupplier(client, supplier.id, actor, data.idempotency_key, 'edited', fields);
  return { supplier_id: supplier.id, name: supplier.name, updated_fields: fields };
}

export async function archiveSupplier(client: PoolClient, data: z.infer<typeof archiveSupplierInput>, actor: string) {
  await archiveWholesaleSupplier(data.supplier_id, env.FAREJADOR_ENV, client);
  await auditSupplier(client, data.supplier_id, actor, data.idempotency_key, 'archived');
  return { supplier_id: data.supplier_id, archived: true };
}

const newSupplier = supplierFields.omit({ notes: true });
const paymentStatus = z.enum(['paid', 'pending']);
const receiptStatus = z.enum(['received', 'pending']);

export const purchaseInput = registerPurchaseFields.extend({
  purchased_at: z.string().datetime({ offset: true }), payment_status: paymentStatus,
  receipt_status: receiptStatus, new_supplier: newSupplier.optional(), idempotency_key: id,
}).strict();
export const lotPurchaseInput = registerLotPurchaseSchema.innerType().extend({
  new_supplier: newSupplier.optional(), idempotency_key: id,
});

type Catalog = z.infer<typeof purchaseInput>;
type Lot = z.infer<typeof lotPurchaseInput>;

function validatePurchase(data: Catalog | Lot) {
  if (!env.WHOLESALE_FINANCE) throw Error('wholesale_finance_disabled');
  if (Boolean(data.supplier_id) === Boolean(data.new_supplier)) throw Error('informe_um_fornecedor');
  if (data.payment_status === 'paid') {
    if (!data.paid_at || !data.payment_method) throw Error('informe_data_e_meio_do_pagamento');
    if (data.due_date || ('installments' in data && data.installments)) throw Error('compra_paga_com_vencimento');
  } else if (data.paid_at) throw Error('compra_pendente_com_data_de_pagamento');
  if (data.receipt_status === 'pending' && 'received_at' in data && data.received_at) {
    throw Error('compra_pendente_com_data_de_recebimento');
  }
}

export async function registerSupplierPurchase(client: PoolClient, data: Catalog | Lot, actor: string) {
  validatePurchase(data);
  const purchase = 'lot' in data
    ? { ...registerLotPurchaseSchema.parse(data), items: [] }
    : registerPurchaseSchema.parse(data);
  const result = await registerWholesalePurchaseOnClient(client, { ...purchase, created_by: actor });
  return { ...result, payment_status: data.payment_status };
}
