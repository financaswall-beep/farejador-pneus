import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { businessDateSaoPaulo } from '../../shared/business-time.js';
import { postMatrizLedgerTransaction } from './matriz-ledger-posting.js';
import { beginIntegrityOperation, completeIntegrityOperation, operationFingerprint, recordIntegrityEvent } from './stage5-integrity.js';
import { cents, shareCents, readPurchaseSharing, type Allocation } from './purchase-sharing-read.js';

const money=z.number().finite().nonnegative().max(9999999999.99).refine(n=>Math.abs(n*100-Math.round(n*100))<0.00015);
const common={revision:z.number().int().nonnegative(),key:z.string().uuid()};
const person=z.object({id:z.string().uuid(),name:z.string().trim().min(1).max(80),
  mode:z.enum(['amount','percent']),value:money}).strict();
const parts=z.array(z.object({id:z.string().uuid(),value:money}).strict()).max(20);
export const sharingSchema=z.discriminatedUnion('kind',[
  z.object({...common,kind:z.literal('agreement'),participants:z.array(person).max(20)}).strict(),
  z.object({...common,kind:z.literal('cash'),transaction_id:z.string().uuid(),allocations:parts}).strict(),
  z.object({...common,kind:z.literal('stock'),movement_id:z.string().uuid(),allocations:parts}).strict(),
  z.object({...common,kind:z.literal('settlement'),participant_id:z.string().uuid(),direction:z.enum(['in','out']),purpose:z.enum(['purchase','sale']).default('purchase'),
    amount:money.refine(n=>n>0),day:z.string().date(),account:z.string().trim().min(1).max(80),method:z.string().trim().min(1).max(60)}).strict(),
  z.object({...common,kind:z.literal('undo'),transaction_id:z.string().uuid(),reason:z.string().trim().min(3).max(150)}).strict(),
]);
type Change=z.input<typeof sharingSchema>;
export class SharingError extends Error {}
function check(condition:unknown,message:string): asserts condition {if (!condition) throw new SharingError(message);}

function validateParts(parts:Allocation[],people:Set<string>) {
  check(parts.every(a=>people.has(a.id) && a.value>0) && new Set(parts.map(a=>a.id)).size===parts.length,
    'Confira os participantes e os valores informados.');
}

export async function writePurchaseSharing(id:string,input:Change,actor:string,environment=env.FAREJADOR_ENV,db=pool) {
  const change=sharingSchema.parse(input);
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const operation={domain:'purchase.sharing',environment,idempotencyKey:change.key,fingerprint:operationFingerprint({id,change})};
    const replay=await beginIntegrityOperation<{revision:number}>(client,operation);
    if(replay.replayed){await client.query('COMMIT');return replay.result;}
    const purchase=await client.query('SELECT id FROM commerce.wholesale_purchases WHERE environment=$1 AND id=$2 FOR UPDATE',[environment,id]);
    check(purchase.rowCount,'Compra não encontrada.');
    if(change.kind==='cash') {
      await client.query('SELECT id FROM finance.matriz_ledger_transactions WHERE environment=$1 AND id=$2 FOR UPDATE',[environment,change.transaction_id]);
    }
    const state=await readPurchaseSharing(client,environment,id);
    check(state.revision===change.revision,'A divisão mudou. Reabra a compra para conferir os dados atuais.');
    check(state.status!=='cancelled' || ['undo','settlement','cash','stock'].includes(change.kind),'Esta compra está cancelada.');
    const people=new Set(state.participants.map(p=>p.id));
    let agreement=state.participants.map(({id,name,mode,value})=>({id,name,mode,value}));
    const stock={...state.stock_allocations};
    let before:unknown,after:unknown=change;
    if(change.kind==='agreement'){
      agreement=change.participants;
      check(new Set(agreement.map(p=>p.id)).size===agreement.length && new Set(agreement.map(p=>p.name.toLocaleLowerCase('pt-BR'))).size===agreement.length,
        'Cada participante precisa de um nome diferente.');
      const total=cents(state.total_amount);
      check(agreement.every(p=>p.mode!=='percent'||p.value<=100) &&
        agreement.reduce((sum,p)=>sum+shareCents(p,total),0)<=total,'As partes ultrapassam o valor da compra.');
      const removed=Array.from(people).filter(key=>!agreement.some(p=>p.id===key));
      if(removed.length) {
        const used=await client.query('SELECT 1 FROM finance.purchase_cash_shares WHERE environment=$1 AND purchase_id=$2 AND participant_id=ANY($3::uuid[]) LIMIT 1',[environment,id,removed]);
        check(!used.rowCount && !state.settlements.some(s=>removed.includes(s.participant_id)) &&
          !Object.values(stock).some(parts=>parts.some(a=>removed.includes(a.id))),'Este participante já tem movimentos vinculados.');
      }
      before=state.participants;
    } else if(change.kind==='cash'){
      const flow=state.flows.find(f=>f.id===change.transaction_id);
      check(flow,'Pagamento ou recebimento indisponível para esta compra.');
      validateParts(change.allocations,people);
      const amount=change.allocations.reduce((n,a)=>n+cents(a.value),0);
      check(amount+cents(flow.other_external)<=cents(flow.gross),'Os valores ultrapassam o dinheiro movimentado.');
      if(flow.kind==='sale' || flow.kind==='sale_refund'){
        const assigned=state.flows.filter(f=>f.kind===flow.kind && f.order_id===flow.order_id && f.id!==flow.id)
          .reduce((n,f)=>n+f.allocations.reduce((s,a)=>s+cents(a.value),0),0);
        check(amount+assigned<=cents(flow.lot_total??0),'Os recebimentos atribuídos ultrapassam a parte deste lote na venda.');
      }
      before=flow.allocations;
      await client.query('DELETE FROM finance.purchase_cash_shares WHERE environment=$1 AND purchase_id=$2 AND transaction_id=$3',[environment,id,flow.id]);
      for(const a of change.allocations) await client.query('INSERT INTO finance.purchase_cash_shares(environment,purchase_id,transaction_id,participant_id,amount) VALUES ($1,$2,$3,$4,$5)',[environment,id,flow.id,a.id,a.value]);
    } else if(change.kind==='stock'){
      const movement=state.movements.find(m=>m.id===change.movement_id);
      check(movement,'Movimento de lote não encontrado.');
      validateParts(change.allocations,people);
      check(change.allocations.every(a=>Number.isInteger(a.value)) &&
        change.allocations.reduce((n,a)=>n+a.value,0)<=Math.abs(movement.quantity_delta),'Confira a quantidade de pneus do movimento.');
      before=stock[movement.id]??null; stock[movement.id]=change.allocations;
      // Until every movement is identified, only validate the balances known with certainty.
      const balances=new Map<string,number>(); let storeBalance=0,unknownIn=0;
      for(const m of state.movements){
        const allocations=stock[m.id],sign=Math.sign(m.quantity_delta);
        if(!allocations){if(sign>0)unknownIn+=m.quantity_delta;continue;}
        let remaining=Math.abs(m.quantity_delta);
        for(const a of allocations){
          const value=(balances.get(a.id)??0)+sign*a.value;
          balances.set(a.id,value);remaining-=a.value;
        }
        storeBalance+=sign*remaining;
        const deficit=[storeBalance,...balances.values()].reduce((n,b)=>n+Math.max(0,-b),0);
        check(deficit<=unknownIn,'A divisão usa mais pneus do que o titular tinha nesse movimento.');
      }
    } else if(change.kind==='settlement'){
      check(people.has(change.participant_id),'Participante não encontrado.');
      check(change.day<=businessDateSaoPaulo(new Date()),'Informe a data em que o dinheiro foi movimentado.');
      const date=change.day+'T12:00:00-03:00',incoming=change.direction==='in';
      const transaction=await postMatrizLedgerTransaction(client,{environment,sourceType:'finance.purchase_share.settlement',sourceId:change.key,
        kind:'participant_settlement',amount:change.amount,occurredAt:date,cashAt:date,description:change.purpose==='sale' ? (incoming?'Repasse de venda recebido':'Repasse de venda pago') : (incoming?'Reembolso de compra recebido':'Acerto de compra pago ao participante'),
        createdBy:actor,lines:[{account_code:'cash',account_class:'asset',side:incoming?'debit':'credit',amount:change.amount},
          {account_code:'participant_clearing',account_class:'asset',side:incoming?'credit':'debit',amount:change.amount}],
        metadata:{purchase_id:id,participant_id:change.participant_id,direction:change.direction,purpose:change.purpose,payment_method:change.method,cash_account:change.account}});
      after={...change,transaction};
    } else {
      const settlement=state.settlements.find(s=>s.id===change.transaction_id && !s.reversed);
      check(settlement,'Acerto não encontrado ou já estornado.');
      await client.query(`SELECT finance.reverse_matriz_ledger_transaction($1::env_t,$2,'finance.purchase_share.reversal',$3,$4::date,
        'Correção de acerto de compra',$5,$4::date,jsonb_build_object('correction_type','entry_error','reason',$6::text,'purchase_id',$7::text))`,
        [environment,settlement.id,change.key,settlement.day,actor,change.reason,id]);
    }
    const result={revision:state.revision+1};
    await client.query(`INSERT INTO finance.purchase_sharing(environment,purchase_id,revision,participants,stock_allocations)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb) ON CONFLICT(environment,purchase_id) DO UPDATE
      SET revision=EXCLUDED.revision,participants=EXCLUDED.participants,stock_allocations=EXCLUDED.stock_allocations`,
      [environment,id,result.revision,JSON.stringify(agreement),JSON.stringify(stock)]);
    await recordIntegrityEvent(client,{...operation,entityTable:'commerce.wholesale_purchases',entityId:id,eventType:change.kind,
      actorLabel:actor,before,after});
    await completeIntegrityOperation(client,operation,'commerce.wholesale_purchases',id,result);
    await client.query('COMMIT'); return result;
  } catch(e){await client.query('ROLLBACK');throw e;} finally {client.release();}
}
