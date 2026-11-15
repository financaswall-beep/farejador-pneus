import type {PoolClient} from 'pg';
import { env } from '../../shared/config/env.js';
import { beginIntegrityOperation, completeIntegrityOperation, moneyCents, operationFingerprint, type MatrizEnvironment } from './stage5-integrity.js';
import { postMatrizLedgerTransaction } from './matriz-ledger-posting.js';
import { applyAdvance, correctApplication, lockAdvance, prefix } from './supplier-advance-ledger.js';
import type { AdvanceCommand } from './supplier-advance-schema.js';

export class MatchingAdvance extends Error {
  constructor(public matches:{id:string;amount:string;day:string}[]){super('Já existe um adiantamento parecido. Confira o registro antes de lançar outro.');}
}
export async function runSupplierAdvance(db:PoolClient,data:AdvanceCommand,actor:string,environment:MatrizEnvironment=env.FAREJADOR_ENV){
  if(!env.MATRIZ_CENTRAL_LEDGER||!env.MATRIZ_CENTRAL_LEDGER_READ||!env.WHOLESALE_FINANCE)throw Error('Financeiro de compras indisponível.');
  const op={environment,domain:'supplier_advance.'+data.action,idempotencyKey:data.idempotency_key,fingerprint:operationFingerprint(data)};
  const previous=await beginIntegrityOperation<{id:string}>(db,op);
  if(previous.replayed)return previous.result;
  const ctx={environment,actor,reason:data.reason,at:data.occurred_at,key:data.idempotency_key};
  let result:{id:string};
  if(data.action==='apply')result=await applyAdvance(db,ctx,data);
  else if(data.action==='restore')result=await correctApplication(db,ctx,data.application_id,data.supplier_id,data.amount);
  else if(data.action==='issue'){
    const supplier=await db.query('SELECT id FROM commerce.wholesale_suppliers WHERE environment=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',[environment,data.supplier_id]);
    if(!supplier.rowCount)throw Error('Fornecedor arquivado ou indisponível.');
    const reference=data.bank_reference?.trim().toUpperCase();
    if(reference){
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[environment+':pix:'+data.cash_account.toLowerCase()+':'+reference]);
      const prior=(await db.query(`SELECT id,amount,metadata,competence_on=($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date same_day
        FROM finance.matriz_ledger_transactions t WHERE environment=$1 AND source_type='finance.supplier_advance.issue'
        AND lower(btrim(metadata->>'cash_account'))=lower($2) AND metadata->>'bank_reference'=$3 AND NOT EXISTS(SELECT FROM finance.matriz_ledger_transactions r
          WHERE r.environment=t.environment AND r.reversal_of_transaction_id=t.id)`,
        [environment,data.cash_account,reference,ctx.at])).rows[0];
      if(prior){
        if(!prior.same_day || prior.metadata.supplier_id!==data.supplier_id || Number(prior.amount)!==data.amount || prior.metadata.payment_method!==data.payment_method)
          throw Error('A referência bancária já identifica outro lançamento.');
        result={id:prior.id};
        await completeIntegrityOperation(db,op,'finance.matriz_ledger_transactions',prior.id,result);return result;
      }
    }
    const matches=(await db.query(`SELECT t.id,t.amount,t.competence_on::text AS day FROM finance.matriz_ledger_transactions t
      WHERE t.environment=$1 AND t.source_type='finance.supplier_advance.issue' AND t.metadata->>'supplier_id'=$2 AND t.amount=$3
      AND t.competence_on=($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date AND lower(t.metadata->>'cash_account')=lower($5)
      AND ($6::text IS NULL OR t.metadata->>'bank_reference' IS NULL) AND NOT(t.id=ANY($7::uuid[]))
      AND NOT EXISTS(SELECT FROM finance.matriz_ledger_transactions r WHERE r.environment=t.environment AND r.reversal_of_transaction_id=t.id)
      ORDER BY t.created_at DESC LIMIT 30`,[environment,data.supplier_id,data.amount,ctx.at,data.cash_account,reference??null,data.distinct_from??[]])).rows;
    if(matches.length)throw new MatchingAdvance(matches as {id:string;amount:string;day:string}[]);
    result={id:await postMatrizLedgerTransaction(db,{environment,sourceType:prefix+'issue',sourceId:ctx.key,kind:'supplier_advance',amount:data.amount,
      occurredAt:ctx.at,cashAt:ctx.at,createdBy:actor,description:'Adiantamento a fornecedor · '+data.reason,
      metadata:{supplier_id:data.supplier_id,payment_method:data.payment_method,cash_account:data.cash_account,bank_reference:reference},
      lines:[{account_code:'supplier_advances',account_class:'asset',side:'debit',amount:data.amount},
        {account_code:'cash',account_class:'asset',side:'credit',amount:data.amount}]})};
  }else{
    const credit=await lockAdvance(db,environment,data.advance_id,data.supplier_id,ctx.at);
    if(moneyCents(data.amount)>moneyCents(credit.available))throw Error('Saldo disponível insuficiente para esta data.');
    const meta={supplier_id:data.supplier_id,advance_id:data.advance_id,reason:data.reason};
    if(data.action==='void'){
      if(data.amount!==credit.amount||credit.current!==credit.amount)throw Error('Desfaça os usos do adiantamento antes de corrigir o registro.');
      const row=(await db.query(`SELECT finance.reverse_matriz_ledger_transaction($1,$2,'finance.supplier_advance.void',$3,
        ($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,$5,$6,($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,$7::jsonb) id`,
        [environment,data.advance_id,ctx.key,ctx.at,'Correção de adiantamento · '+data.reason,actor,JSON.stringify({...meta,correction_type:'entry_error'})])).rows[0];
      result={id:row.id};
    }else result={id:await postMatrizLedgerTransaction(db,{environment,sourceType:prefix+'refund',sourceId:ctx.key,kind:'supplier_advance_refund',
      amount:data.amount,occurredAt:ctx.at,cashAt:ctx.at,createdBy:actor,description:'Devolução de adiantamento · '+data.reason,
      metadata:{...meta,payment_method:data.payment_method,cash_account:data.cash_account},lines:[
        {account_code:'cash',account_class:'asset',side:'debit',amount:data.amount},
        {account_code:'supplier_advances',account_class:'asset',side:'credit',amount:data.amount}]})};
  }
  await completeIntegrityOperation(db,op,'finance.matriz_ledger_transactions',result.id,result);return result;
}
