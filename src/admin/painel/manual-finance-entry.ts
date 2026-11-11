import {manualEntrySchema,reverseManualEntrySchema,type ManualFinanceEntry,type ManualFinanceCorrection} from './manual-finance-entry-schema.js';
import type {Pool} from 'pg';
import {pool} from '../../persistence/db.js';
import {env} from '../../shared/config/env.js';
import {postMatrizLedgerTransaction} from './matriz-ledger-posting.js';

/** A própria transação imutável é a fonte da entrada avulsa; não gera venda nem estoque. */
export async function createManualFinanceEntry(input:ManualFinanceEntry,actor:string,environment=env.FAREJADOR_ENV,db:Pool=pool){
  const data=manualEntrySchema.parse(input),contribution=data.kind==='owner_contribution';
  const client=await db.connect();
  try {
    const id=await postMatrizLedgerTransaction(client,{
      environment,sourceType:'finance.manual_entry',sourceId:data.idempotency_key,
      kind:contribution?'owner_contribution':'manual_income',amount:data.amount,
      occurredAt:data.occurred_at,cashAt:data.occurred_at,
      description:(contribution?'Aporte do proprietário: ':'Receita avulsa: ')+data.description,createdBy:actor,
      lines:[
        {account_code:'cash',account_class:'asset',side:'debit',amount:data.amount},
        {account_code:contribution?'owner_equity':'other_revenue',account_class:contribution?'equity':'revenue',side:'credit',amount:data.amount},
      ],
      metadata:{entry_kind:data.kind,category:contribution?'aporte':data.category,
        payment_method:data.payment_method,cash_account:data.cash_account},
    });
    return {id};
  } finally {client.release();}
}
export async function reverseManualFinanceEntry(id:string,input:ManualFinanceCorrection,actor:string,
  environment=env.FAREJADOR_ENV,db:Pool=pool){
  const data=reverseManualEntrySchema.parse(input);
  const found=await db.query<{id:string}>(`SELECT finance.reverse_matriz_ledger_transaction(
    $1::env_t,t.id,'finance.manual_entry.reversal',$3,
    ($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,$5,$6,
    ($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,
    jsonb_build_object('reason',$7::text,'category',t.metadata->>'category','entry_kind',t.metadata->>'entry_kind',
      'payment_method',t.metadata->>'payment_method','cash_account',t.metadata->>'cash_account')) id
    FROM finance.matriz_ledger_transactions t WHERE t.environment=$1 AND t.id=$2
      AND t.source_type='finance.manual_entry' AND t.transaction_kind IN ('manual_income','owner_contribution')
      AND t.cash_on<=($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date`,
    [environment,id,data.idempotency_key,data.occurred_at,`Estorno de entrada: ${data.reason}`,actor,data.reason]);
  if(!found.rows[0])throw Error('manual_entry_not_found_or_date_invalid');
  return found.rows[0];
}
