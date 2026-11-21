import type {PoolClient} from 'pg';
import {z} from 'zod';
import {pool} from '../../persistence/db.js';
import {env} from '../../shared/config/env.js';
import {recordIntegrityEvent} from '../painel/stage5-integrity.js';
import {effectiveCashAccountSql} from '../painel/retail-cash-account.js';
import {id} from './retail-delivery-schemas.js';
import {registerInventoryRead,registerInventoryWrite} from './inventory-registry.js';

const receipts=`SELECT t.id AS recebimento_id,o.order_number AS numero_pedido,t.amount::float8 AS valor,
  t.metadata->>'payment_method' AS forma,t.metadata->>'cash_account' AS conta_original,`+effectiveCashAccountSql+` AS conta
  FROM commerce.orders o JOIN core.units u ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
  JOIN finance.matriz_ledger_transactions t ON t.environment=o.environment AND t.source_id=o.id::text
  WHERE o.environment=$1 AND o.id=$2 AND o.partner_order_id IS NULL AND o.idempotency_key LIKE 'milly-varejo-%'
  AND o.status<>'cancelled' AND t.cash_on IS NOT NULL AND
  ((t.source_type='commerce.order.revenue' AND t.transaction_kind='sale_cash') OR
    (t.source_type LIKE 'commerce.order.payment%' AND t.transaction_kind='payment'))
  AND NOT EXISTS(SELECT 1 FROM finance.matriz_ledger_transactions r WHERE r.environment=t.environment AND r.reversal_of_transaction_id=t.id)`;
registerInventoryRead('consultar_recebimentos_balcao_milly','Mostra os recebimentos de uma venda de balcão criada pela Milly, os valores, as contas originais e as contas corrigidas.',
  z.object({order_id:id}).strict(),async data=>({recebimentos:(await pool.query(receipts+' ORDER BY t.id',[env.FAREJADOR_ENV,data.order_id])).rows}));
const schema=z.object({idempotency_key:id,order_id:id,recebimento_id:id,conta_atual:z.string().trim().min(2).max(80),
  conta_correta:z.string().trim().min(2).max(80),motivo:z.string().trim().min(4).max(300)}).strict();
async function preview(db:PoolClient,data:z.infer<typeof schema>) {
  if (!env.MATRIZ_CENTRAL_LEDGER) throw Error('central_ledger_disabled');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['retail-receipt-account:'+data.recebimento_id]);
  const row=(await db.query(receipts+' AND t.id=$3 FOR UPDATE OF o',[env.FAREJADOR_ENV,data.order_id,data.recebimento_id])).rows[0];
  if(!row || row.conta!==data.conta_atual) throw Error('confira_conta_e_recebimento_da_venda');
  if(data.conta_atual===data.conta_correta) throw Error('conta_inalterada');
  return {...row,conta_correta:data.conta_correta,entrada_nova:0,baixa_adicional:0};
}
registerInventoryWrite('retail','corrigir_conta_recebimento_balcao','Corrige a conta informada em um recebimento de balcão criado pela Milly. Preserva o histórico e o valor do pagamento. Não movimenta dinheiro entre bancos.',
  schema,async(db,data,actor)=>{
    const prior=await preview(db,data);
    await recordIntegrityEvent(db,{environment:env.FAREJADOR_ENV,domain:'matriz_retail',entityTable:'finance.matriz_ledger_transactions',
      entityId:data.recebimento_id,eventType:'retail_receipt_account_corrected',actorLabel:actor,idempotencyKey:data.idempotency_key,
      before:{cash_account:data.conta_atual},after:{cash_account:data.conta_correta,order_id:data.order_id,reason:data.motivo}});
    return {numero_pedido:prior.numero_pedido,recebimento_id:data.recebimento_id,conta:data.conta_correta,valor:prior.valor};
  },false,preview);
