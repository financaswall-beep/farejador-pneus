import type {PoolClient} from 'pg';
import { randomUUID } from 'node:crypto';
import { moneyCents, type MatrizEnvironment } from './stage5-integrity.js';
import { postMatrizLedgerTransaction } from './matriz-ledger-posting.js';
import { lockMatrizObligation } from './matriz-ledger-obligation-lock.js';
import { purchaseSchedule } from './purchase-installment-balances.js';
export const prefix='finance.supplier_advance.';
type Db=PoolClient;
type Place={environment:MatrizEnvironment;actor:string;at:string;reason:string;key:string};
type Allocation={id:string;advance_id:string;purchase_id:string;supplier_id:string;amount:string;day:string;metadata:Record<string,string|number>;payment_id:string;obligation_id:string};
export const liveApplications=`SELECT m.id,m.advance_id,m.purchase_id,m.supplier_id,m.amount,m.competence_on::text AS day,m.metadata,
  p.id payment_id,p.obligation_transaction_id obligation_id FROM finance.supplier_advance_movements m
  JOIN finance.matriz_ledger_payments p ON p.environment=m.environment AND p.payment_transaction_id=m.id
  WHERE m.environment=$1 AND m.source_type='finance.supplier_advance.apply' AND NOT EXISTS(
   SELECT FROM finance.matriz_ledger_transactions r WHERE r.environment=m.environment AND r.reversal_of_transaction_id=m.id)`;

export async function lockAdvance(db:Db,env:MatrizEnvironment,id:string,supplier:string,at:string){
  const root=(await db.query(`SELECT id,amount FROM finance.matriz_ledger_transactions
    WHERE environment=$1 AND id=$2 AND source_type='finance.supplier_advance.issue' AND metadata->>'supplier_id'=$3
    AND competence_on<=($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date FOR UPDATE`,[env,id,supplier,at])).rows[0];
  if(!root)throw Error('Adiantamento indisponível para este fornecedor ou data.');
  const balance=(await db.query(`WITH days AS (
    SELECT greatest(competence_on,($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date) AS day,sum(delta) change
    FROM finance.supplier_advance_movements WHERE environment=$1 AND advance_id=$2 GROUP BY 1
  ) SELECT min(running) available,sum(change) AS current_balance FROM
    (SELECT change,sum(change) OVER (ORDER BY day) running FROM days) balances`,[env,id,at])).rows[0];
  return {amount:Number(root.amount),available:Number(balance.available),current:Number(balance.current_balance)};
}

export async function lockPurchase(db:Db,env:MatrizEnvironment,id:string,supplier:string,at:string){
  const row=(await db.query(`SELECT t.id FROM commerce.wholesale_purchases p JOIN finance.matriz_ledger_transactions t
    ON t.environment=p.environment AND t.source_id=p.id::text AND t.source_type='commerce.wholesale_purchase.accrual'
    AND t.transaction_kind='purchase_payable' WHERE p.environment=$1 AND p.id=$2 AND p.supplier_id=$3
    AND p.status<>'cancelled' AND p.purchased_at::timestamptz AT TIME ZONE 'America/Sao_Paulo'
      < (($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date+1) FOR UPDATE OF p`,[env,id,supplier,at])).rows[0];
  if(!row)throw Error('Compra a prazo indisponível para este fornecedor ou data.');
  await lockMatrizObligation(db,env,row.id);
  return String(row.id);
}
export async function syncPurchaseStatus(db:Db,env:MatrizEnvironment,id:string,obligation:string,at:string){
  const row=(await db.query(`SELECT finance.matriz_ledger_obligation_balance($1::env_t,$2) balance`,[env,obligation])).rows[0];
  const settled=Number(row.balance)===0;
  await db.query(`UPDATE commerce.wholesale_purchases SET payment_status=CASE WHEN $3 THEN 'paid' ELSE 'pending' END,
    paid_at=CASE WHEN $3 THEN $4::timestamptz END WHERE environment=$1 AND id=$2 AND status<>'cancelled'`,[env,id,settled,at]);
  return Number(row.balance);
}
export async function postApplication(db:Db,ctx:Place,amount:number,obligation:string,meta:Record<string,unknown>){
  const id=await postMatrizLedgerTransaction(db,{environment:ctx.environment,sourceType:prefix+'apply',sourceId:ctx.key,
    kind:'payment',amount,occurredAt:ctx.at,createdBy:ctx.actor,description:'Abatimento de adiantamento · '+ctx.reason,
    metadata:{...meta,obligation_id:obligation,reason:ctx.reason},lines:[
      {account_code:'accounts_payable',account_class:'liability',side:'debit',amount},
      {account_code:'supplier_advances',account_class:'asset',side:'credit',amount}]});
  await db.query(`SELECT finance.record_matriz_ledger_payment($1::env_t,$2,$3,$4::timestamptz,$5,NULL)`,
    [ctx.environment,obligation,id,ctx.at,ctx.actor]);
  return id;
}
export async function applyAdvance(db:Db,ctx:Place,data:{supplier_id:string;purchase_id:string;advance_id:string;installment?:number;amount:number}){
  const obligation=await lockPurchase(db,ctx.environment,data.purchase_id,data.supplier_id,ctx.at);
  const credit=await lockAdvance(db,ctx.environment,data.advance_id,data.supplier_id,ctx.at);
  const balance=Number((await db.query('SELECT finance.matriz_ledger_obligation_balance($1,$2) balance',
    [ctx.environment,obligation])).rows[0].balance);
  const schedule=await purchaseSchedule(db,ctx.environment,data.purchase_id);
  const part=schedule.find(s=>s.installment_number===data.installment);
  if((schedule.length || data.installment!==undefined) && !part)throw Error('Selecione uma parcela válida.');
  if(moneyCents(data.amount)>moneyCents(Math.min(credit.available,balance,Number(part?.balance??balance))))
    throw Error('O valor ultrapassa o saldo disponível ou o saldo da parcela.');
  const id=await postApplication(db,ctx,data.amount,obligation,{supplier_id:data.supplier_id,advance_id:data.advance_id,
    purchase_id:data.purchase_id,purchase_installment:part?.installment_number,installment_due:part?.due_date,
    installment_amount:part?.amount,installment_balance_before:part?.balance});
  const remaining=await syncPurchaseStatus(db,ctx.environment,data.purchase_id,obligation,ctx.at);
  return {id,remaining_balance:remaining,available:(moneyCents(credit.current)-moneyCents(data.amount))/100};
}
export async function restoreApplication(db:Db,ctx:Place,app:Allocation,amount:number){
  if(moneyCents(amount)>moneyCents(Number(app.amount)))throw Error('Valor maior que o abatimento ativo.');
  const day=(await db.query("SELECT ($1::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date::text AS day",[ctx.at])).rows[0].day;
  if(day<app.day)throw Error('A correção deve ocorrer a partir da data do abatimento.');
  await lockAdvance(db,ctx.environment,app.advance_id,app.supplier_id,ctx.at);
  const meta={...app.metadata,advance_id:app.advance_id,supplier_id:app.supplier_id,purchase_id:app.purchase_id,reason:ctx.reason};
  const row=(await db.query(`SELECT finance.reverse_matriz_ledger_transaction($1,$2,'finance.supplier_advance.restore',$3,
    $4::date,$5,$6,NULL,$7::jsonb) id`,[ctx.environment,app.id,ctx.key,day,'Recomposição de adiantamento · '+ctx.reason,ctx.actor,JSON.stringify(meta)])).rows[0];
  await db.query(`SELECT finance.record_matriz_ledger_payment($1,$2,$3,$4::timestamptz,$5,$6)`,
    [ctx.environment,app.obligation_id,row.id,ctx.at,ctx.actor,app.payment_id]);
  const retained=(moneyCents(Number(app.amount))-moneyCents(amount))/100;
  if(retained>0)await postApplication(db,{...ctx,key:randomUUID()},retained,app.obligation_id,{...meta,replaces_application:app.id});
  await syncPurchaseStatus(db,ctx.environment,app.purchase_id,app.obligation_id,ctx.at);
  return {id:String(row.id)};
}

/** O chamador já travou a compra. Uma falha no estoque desfaz também as recomposições. */
export async function restorePurchaseCredits(db:Db,env:MatrizEnvironment,purchaseId:string,actor:string,reason:string,limit=Infinity){
  const apps=(await db.query<Allocation>(liveApplications+' AND m.purchase_id=$2 ORDER BY m.advance_id,m.created_at,m.id',[env,purchaseId])).rows;
  let left=limit;
  for(const app of apps){
    if(left<=0)break;
    const amount=Math.min(left,Number(app.amount));
    await restoreApplication(db,{environment:env,actor,reason,at:new Date().toISOString(),key:randomUUID()},app,amount);
    left=left===Infinity?Infinity:(moneyCents(left)-moneyCents(amount))/100;
  }
}
export async function correctApplication(db:Db,ctx:Place,id:string,supplier:string,amount:number){
  // Cada recomposição parcial estorna a linha e mantém o restante em outra aplicação.
  // Aceita tanto o identificador original da operação quanto o da parcela remanescente.
  const lineage=`WITH RECURSIVE chain(id) AS (
    SELECT id FROM finance.supplier_advance_movements WHERE environment=$1 AND id=$2 AND supplier_id=$3
    UNION ALL SELECT m.id FROM finance.supplier_advance_movements m JOIN chain c
      ON m.metadata->>'replaces_application'=c.id::text
      WHERE m.environment=$1 AND m.supplier_id=$3 AND m.source_type='finance.supplier_advance.apply'
  ) `;
  const get=async()=>(await db.query<Allocation>(lineage+liveApplications+
    ' AND m.id IN (SELECT id FROM chain) AND m.supplier_id=$3',[ctx.environment,id,supplier])).rows[0];
  const initial=await get();
  if(!initial)throw Error('Abatimento indisponível.');
  await lockPurchase(db,ctx.environment,initial.purchase_id,supplier,ctx.at);
  const current=await get();
  if(!current)throw Error('O abatimento já foi desfeito.');
  return restoreApplication(db,ctx,current,amount);
}
