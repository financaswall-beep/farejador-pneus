import type { PoolClient } from 'pg';
import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { calculateReceivedPurchaseMoney } from '../painel/purchase-money.js';
import {
  applyPurchaseReceiptQuantities, confirmWholesalePurchaseOnClient,
} from '../painel/queries-fornecedores-registro.js';
import { confirmWholesalePurchaseSchema } from '../painel/route-schemas-purchases.js';
import { operationFingerprint } from '../painel/stage5-integrity.js';
import { registerInventoryRead, registerInventoryWrite } from './inventory-registry.js';
import { withDotReadOnly } from './read-only.js';

const lookupSchema = z.object({ compra_id: z.string().uuid() }).strict();
const receiptSchema = lookupSchema.extend({
  revisao: z.string().regex(/^[a-f0-9]{64}$/).describe('Revisão da compra retornada pela consulta.'),
  items: confirmWholesalePurchaseSchema.shape.items.describe(
    'Informe todos os itens e as quantidades aceitas se o dono declarar divergência. Omita para recebimento integral.',
  ),
  idempotency_key: z.string().uuid(),
}).strict();

interface ReceiptHeader {
  compra_id: string;
  fornecedor_id: string;
  fornecedor: string;
  pedido_compra_id: string | null;
  data_compra: string;
  tipo: 'catalog' | 'lot';
  status: string;
  stock_applied: boolean;
  valor_brl: number;
  frete_brl: number;
  desconto_brl: number;
  situacao_pagamento: string;
  vencimento: string | null;
  pago_em: string | null;
}

interface ReceiptLine {
  id: string;
  measure: string;
  brand: string | null;
  tire_condition: string | null;
  vehicle_type: string | null;
  quantity: number;
  ordered_quantity: number;
  unit_cost: number;
}

async function readReceiptCandidate(db: Pick<PoolClient, 'query'>, purchaseId: string, lock = false) {
  const scope = [env.FAREJADOR_ENV, purchaseId];
  const { rows: [purchase] } = await db.query<ReceiptHeader>(
    `SELECT p.id compra_id,p.supplier_id fornecedor_id,s.name fornecedor,p.purchase_order_id pedido_compra_id,
        p.purchased_at::text data_compra,p.purchase_kind tipo,p.status,p.stock_applied,p.total_amount::float8 valor_brl,
        p.freight_amount::float8 frete_brl,p.discount_amount::float8 desconto_brl,p.payment_status situacao_pagamento,
        p.due_date::text vencimento,p.paid_at::text pago_em
       FROM commerce.wholesale_purchases p
       JOIN commerce.wholesale_suppliers s ON s.environment=p.environment AND s.id=p.supplier_id
      WHERE p.environment=$1 AND p.id=$2${lock ? ' FOR UPDATE OF p FOR SHARE OF s' : ''}`,
    scope,
  );
  if (!purchase) throw Error('compra_nao_encontrada');
  if (purchase.status === 'cancelled') throw Error('compra_cancelada');
  if (purchase.status !== 'pending' || purchase.stock_applied) throw Error('compra_ja_recebida');
  const { rows: items } = await db.query<ReceiptLine>(
    `SELECT id,measure,brand,tire_condition,vehicle_type,quantity,ordered_quantity,unit_cost::float8
       FROM commerce.wholesale_purchase_lines WHERE environment=$1 AND purchase_id=$2 ORDER BY id`,
    scope,
  );
  if (!items.length) throw Error('compra_sem_itens');
  return { purchase, items, revisao: operationFingerprint({ purchase, items }) };
}

registerInventoryRead('consultar_compra_para_receber',
  'Mostra fornecedor, data, valor, itens, quantidades e revisão de compra da Matriz pendente de recebimento. Localize a compra existente por consultar_compras_matriz antes de usar o UUID. A consulta não altera estoque.',
  lookupSchema, async ({ compra_id }) => withDotReadOnly(async db => {
    const { purchase, items, revisao } = await readReceiptCandidate(db, compra_id);
    return { compra: purchase, itens: items, revisao };
  }));

async function previewReceipt(db: PoolClient, data: z.output<typeof receiptSchema>) {
  const { purchase, items, revisao } = await readReceiptCandidate(db, data.compra_id, true);
  if (revisao !== data.revisao) throw Error('compra_alterada_consulte_novamente');
  const effective = applyPurchaseReceiptQuantities(items, data.items);
  if (purchase.tipo === 'lot' && effective.some(item => item.accepted_quantity !== item.ordered_quantity)) {
    throw Error('lot_receipt_quantity_mismatch');
  }
  const valor_apos_recebimento_brl = purchase.tipo === 'lot' ? purchase.valor_brl
    : calculateReceivedPurchaseMoney(effective, purchase.frete_brl, purchase.desconto_brl).totalCents / 100;
  return { compra: purchase, itens_aceitos: effective, valor_apos_recebimento_brl };
}

registerInventoryWrite('purchase_receipt', 'confirmar_recebimento_compra',
  'Recebe no estoque da Matriz uma compra pendente já cadastrada. Consulte por UUID e confira a revisão. Apresente fornecedor, itens, quantidades aceitas e efeito no valor da compra. Lote fechado é recebido integralmente. Solicite o aval explícito do dono por voz nesta conversa. Após o aval, use confirmar_operacao_milly com canal_autorizacao=voz e repita a chamada original. Não ofereça botão ou link para autorizar. Informe a entrada apenas quando executada=true.',
  receiptSchema, (db, data, actor) => confirmWholesalePurchaseOnClient(db, {
    purchase_id: data.compra_id,
    items: data.items,
    confirmed_by: actor,
    idempotency_key: `milly:${data.idempotency_key}`,
  }), false, previewReceipt);
