import type { PoolClient } from 'pg';
import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { businessDateSaoPaulo, isNotFutureBusinessDate } from '../../shared/business-time.js';
import { postMatrizLedgerTransaction } from '../painel/matriz-ledger-posting.js';
import { lockMatrizObligationBreakdown } from '../painel/matriz-ledger-obligation-lock.js';
import { lockSettlementObligation } from '../painel/matriz-ledger-settlement-payment.js';
import { syncPartnerInstallmentDueDate } from '../painel/partner-installment-due-date.js';
import { recordIntegrityEvent, moneyCents } from '../painel/stage5-integrity.js';

export const id = z.string().uuid();
export const money = z.number().finite().positive().max(999_999_999.99).multipleOf(0.01);
export const instant = z.string().datetime({offset:true}).refine(isNotFutureBusinessDate,'data_futura');
const label = z.string().trim().min(2).max(180);
export const serviceInput = z.object({cliente:label,descricao:label,valor:money,competencia:instant,
  vencimento:z.string().date(),idempotency_key:id}).strict();
export async function createService(db:PoolClient, data:z.infer<typeof serviceInput>, actor:string) {
  if (data.vencimento < businessDateSaoPaulo(new Date(data.competencia))) throw Error('vencimento_antes_da_competencia');
  const obligation_id = await postMatrizLedgerTransaction(db,{
    environment:env.FAREJADOR_ENV,sourceType:'finance.service_receivable',sourceId:data.idempotency_key,
    kind:'service_receivable',amount:data.valor,occurredAt:data.competencia,dueDate:data.vencimento,
    description:data.cliente+' · '+data.descricao,createdBy:actor,
    lines:[{account_code:'accounts_receivable',account_class:'asset',side:'debit',amount:data.valor},
      {account_code:'other_revenue',account_class:'revenue',side:'credit',amount:data.valor}],
    metadata:{category:'servicos',cliente:data.cliente},
  });
  return {obligation_id,valor:data.valor,vencimento:data.vencimento};
}

export const recurrenceInput=z.object({descricao:label,categoria:z.string().regex(/^[a-z0-9_]{2,40}$/),
  valor_mensal:money,primeiro_vencimento:z.string().date(),meses:z.number().int().min(1).max(36),idempotency_key:id}).strict();
export function monthlyDue(start:string, index:number) {
  const [year,month,day]=start.split('-').map(Number) as [number,number,number];
  const last=new Date(Date.UTC(year,month+index,0));
  last.setUTCDate(Math.min(last.getUTCDate(),day));
  return last.toISOString().slice(0,10);
}
export async function scheduleExpenses(db:PoolClient,data:z.infer<typeof recurrenceInput>,actor:string) {
  const environment=env.FAREJADOR_ENV;
  if (!env.MATRIZ_EXPENSES) throw Error('expenses_disabled');
  const category=await db.query('SELECT slug FROM commerce.matriz_expense_categories WHERE environment=$1 AND slug=$2 AND archived_at IS NULL FOR SHARE',[environment,data.categoria]);
  if (!category.rowCount) throw Error('category_invalid');
  const parcelas=[];
  for (let i=0;i<data.meses;i++) {
    const due=monthlyDue(data.primeiro_vencimento,i);
    const obligation_id=await postMatrizLedgerTransaction(db,{
      environment,sourceType:'finance.recurring_expense',sourceId:data.idempotency_key+':'+(i+1),
      kind:'expense_payable',amount:data.valor_mensal,occurredAt:due+'T12:00:00-03:00',dueDate:due,
      description:data.descricao+' · '+(i+1)+'/'+data.meses,createdBy:actor,
      lines:[{account_code:'expense_'+data.categoria,account_class:'expense',side:'debit',amount:data.valor_mensal},
        {account_code:'accounts_payable',account_class:'liability',side:'credit',amount:data.valor_mensal}],
      metadata:{serie:data.idempotency_key,category:data.categoria,parcela:i+1},
    });
    parcelas.push({obligation_id,vencimento:due,valor:data.valor_mensal});
  }
  return {serie:data.idempotency_key,parcelas};
}

export const agreementInput=z.object({obligation_id:id,saldo_esperado:money,
  parcelas:z.array(z.object({due_date:z.string().date(),amount:money}).strict()).min(1).max(120),idempotency_key:id}).strict();
export async function renegotiate(db:PoolClient,data:z.infer<typeof agreementInput>,actor:string) {
  const environment=env.FAREJADOR_ENV;
  const obligation=await lockSettlementObligation(db,environment,data.obligation_id);
  const plan=obligation.sale_plan;
  if (!plan || !obligation.source_type.startsWith('commerce.wholesale_order.')) throw Error('venda_sem_acordo_parcelado');
  const today=businessDateSaoPaulo(new Date());
  if (data.parcelas.some((p,i)=>p.due_date < (i ? data.parcelas[i-1]!.due_date : today))) throw Error('sale_plan_dates_invalid');
  const open=moneyCents(Number(obligation.open_amount));
  if (open!==moneyCents(data.saldo_esperado)||open!==data.parcelas.reduce((sum,p)=>sum+moneyCents(p.amount),0))
    throw Error('sale_plan_total_mismatch');
  // Preserve the index of every previously paid installment for payment reversals.
  // Keep gross paid amounts so generic (FIFO) receipts are still allocated exactly once.
  const preserved=plan.installments.map(p=>({due_date:p.due_date,amount:(moneyCents(p.amount)-moneyCents(p.balance))/100}));
  while (preserved.length && preserved.at(-1)!.amount===0) preserved.pop();
  const parts=[...preserved,...data.parcelas];
  if (parts.length>120) throw Error('limite_de_parcelas');
  const order=await db.query(`UPDATE commerce.wholesale_orders SET installment_agreement=$3::jsonb,
    installment_due_dates='{}'::jsonb,due_date=$4 WHERE environment=$1 AND id=$2 AND status='confirmed'
    AND payment_status='pending' RETURNING id`,[environment,obligation.source_id,JSON.stringify(parts),data.parcelas[0]!.due_date]);
  if (!order.rowCount) throw Error('sale_installment_changed');
  if (obligation.source_type==='commerce.wholesale_order.arrival_revenue') {
    await db.query("SELECT set_config('app.matrix_partner_bridge','on',true)");
    await syncPartnerInstallmentDueDate(db,environment,obligation.id,obligation.source_id);
  }
  const after=(await lockSettlementObligation(db,environment,data.obligation_id)).sale_plan!;
  if (moneyCents(after.balance)!==open || after.installments.slice(preserved.length).some((p,i)=>
    moneyCents(p.balance)!==moneyCents(data.parcelas[i]!.amount))) throw Error('acordo_inconsistente');
  await recordIntegrityEvent(db,{environment,domain:'wholesale_sale',entityTable:'commerce.wholesale_orders',entityId:obligation.source_id,
    actorLabel:actor,eventType:'installments_renegotiated',idempotencyKey:data.idempotency_key,before:plan,after});
  return {order_id:obligation.source_id,acordo:after};
}

export const reversalInput=z.object({pagamento_id:id,valor_esperado:money,motivo:label,ocorrido_em:instant,idempotency_key:id}).strict();
export async function reverseSettlement(db:PoolClient,data:z.infer<typeof reversalInput>,actor:string) {
  const environment=env.FAREJADOR_ENV;
  const row=(await db.query(`SELECT p.id,p.amount,p.paid_at,p.obligation_transaction_id obligation_id,
    o.source_type origin,o.source_id, t.id tx,t.metadata,t.source_type FROM finance.matriz_ledger_payments p
    JOIN finance.matriz_ledger_transactions o ON o.id=p.obligation_transaction_id AND o.environment=p.environment
    JOIN finance.matriz_ledger_transactions t ON t.id=p.payment_transaction_id AND t.environment=p.environment
    WHERE p.environment=$1 AND t.id=$2 AND p.payment_kind='settlement'`,[environment,data.pagamento_id])).rows[0];
  if (!row || !['commerce.order.partial_payment','commerce.wholesale_order.partial_payment','commerce.wholesale_purchase.partial_payment',
    'finance.matriz_ledger_obligation.settlement','finance.recurring_expense.payment','commerce.order.payment','commerce.wholesale_order.payment',
    'commerce.wholesale_purchase.payment'].includes(row.source_type) || !row.metadata.obligation_id) throw Error('baixa_nao_corrigivel');
  const breakdown=await lockMatrizObligationBreakdown(db,environment,row.obligation_id);
  if (breakdown.reversed || moneyCents(+row.amount)!==moneyCents(data.valor_esperado) || new Date(data.ocorrido_em)<new Date(row.paid_at))
    throw Error('baixa_diverge_da_autorizacao');
  const isSale=['commerce.wholesale_order.arrival_revenue','commerce.wholesale_order.revenue'].includes(row.origin);
  const linked=isSale && (await db.query('SELECT id FROM commerce.partner_purchases WHERE environment=$1 AND source_wholesale_order_id=$2 AND deleted_at IS NULL',[environment,row.source_id])).rows[0];
  if(linked) {
    await db.query("SELECT set_config('app.matrix_partner_bridge','on',true)");
    const event=await db.query(`INSERT INTO finance.partner_payable_events(environment,unit_id,payable_id,amount,paid_at,payment_method,
      idempotency_key,created_by,reversal_of)
      SELECT e.environment,e.unit_id,e.payable_id,-e.amount,$4::timestamptz,e.payment_method,$5,$6,e.id
      FROM finance.partner_payable_events e JOIN finance.partner_payables f ON f.environment=e.environment AND f.id=e.payable_id
      WHERE e.environment=$1 AND f.source_purchase_id=$2 AND e.idempotency_key=$3 AND e.amount=$7 AND f.deleted_at IS NULL RETURNING id`,
      [environment,linked.id,row.metadata.settlement_key ?? (await db.query(`SELECT idempotency_key FROM audit.events
         WHERE environment=$1 AND entity_id=$2 AND event_type='central_settlement'`,[environment,row.tx])).rows[0]?.idempotency_key,
       data.ocorrido_em,data.idempotency_key,actor,row.amount]);
    if (!event.rowCount) throw Error('pagamento_espelhado_nao_identificado');
  }
  const day=businessDateSaoPaulo(new Date(data.ocorrido_em));
  const reverse=(await db.query(`SELECT finance.reverse_matriz_ledger_transaction($1::env_t,$2,'finance.settlement.reversal',$3,
    $4::date,$5,$6,$4::date,$7::jsonb) id`,[environment,row.tx,data.idempotency_key,day,'Correção de baixa · '+data.motivo,actor,
    JSON.stringify({...row.metadata,correction_type:'entry_error',reason:data.motivo})])).rows[0]!.id;
  await db.query('SELECT finance.record_matriz_ledger_payment($1::env_t,$2,$3,$4::timestamptz,$5,$6)',
    [environment,row.obligation_id,reverse,data.ocorrido_em,actor,row.id]);
  if(isSale) {
    const updated=await db.query(`UPDATE commerce.wholesale_orders SET payment_status='pending',paid_at=NULL
      WHERE environment=$1 AND id=$2 AND status='confirmed' RETURNING id`,[environment,row.source_id]);
    if(!updated.rowCount) throw Error('sale_installment_changed');
    const due=(await lockSettlementObligation(db,environment,row.obligation_id)).sale_plan?.next_due;
    if (due) await db.query('UPDATE commerce.wholesale_orders SET due_date=$3 WHERE environment=$1 AND id=$2',[environment,row.source_id,due]);
    if (linked) {
      const dueDate=due ?? (await db.query('SELECT due_date::text d FROM commerce.wholesale_orders WHERE environment=$1 AND id=$2',[environment,row.source_id])).rows[0]?.d;
      if(!dueDate) throw Error('vencimento_espelhado_indisponivel');
      await db.query("UPDATE commerce.partner_purchases SET payment_status='payable',payable_due_date=$3::date WHERE environment=$1 AND id=$2",[environment,linked.id,dueDate]);
      if (due) await syncPartnerInstallmentDueDate(db,environment,row.obligation_id,row.source_id);
    }
  } else if(row.origin==='commerce.wholesale_purchase.accrual') {
    const updated=await db.query("UPDATE commerce.wholesale_purchases SET payment_status='pending',paid_at=NULL WHERE environment=$1 AND id=$2 AND status<>'cancelled' RETURNING id",[environment,row.source_id]);
    if(!updated.rowCount) throw Error('payable_not_found');
  } else if(row.origin==='commerce.order.revenue') {
    const updated=await db.query("UPDATE commerce.orders SET payment_method='A receber' WHERE environment=$1 AND id=$2 AND status<>'cancelled' RETURNING id",[environment,row.source_id]);
    if(!updated.rowCount) throw Error('receivable_not_found');
  }
  return {estorno_id:reverse,obligation_id:row.obligation_id,saldo:(await lockSettlementObligation(db,environment,row.obligation_id)).open_amount};
}
