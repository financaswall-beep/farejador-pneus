import type { Pool } from 'pg';
import { moneyCents, type MatrizEnvironment } from './stage5-integrity.js';

export type Participant = {id:string; name:string; mode:'amount'|'percent'; value:number};
export type Allocation = {id:string; value:number};
export type StockAllocations = Record<string,Allocation[]>;
type Reader = Pick<Pool,'query'>;
export const cents = (value:string|number) => moneyCents(Number(value));
export const shareCents = (p:Participant,total:number) =>
  p.mode==='amount' ? cents(p.value) : Math.round(total*cents(p.value)/10000);

interface Purchase {
  id:string; status:string; total_amount:string; purchased_on:string; payment_status:string;
  revision:number; participants:Participant[]; stock_allocations:StockAllocations;
  lot_id:string|null; lot_number:string|null; quantity_on_hand:number|null; quantity:number|null;
}
export interface Flow {
  id:string; kind:'supplier'|'sale'|'supplier_refund'|'sale_refund'; order_id:string|null; day:string; gross:string;
  lot_total:string|null; other_external:string; allocations:Allocation[];
}
interface Movement {id:string; source:string; quantity_delta:number; day:string; order_id:string|null}
interface Settlement {id:string; participant_id:string; day:string; amount:string; direction:'in'|'out'; purpose:'purchase'|'sale'; reversed:boolean}

const flowsSql = `WITH sales AS (
  SELECT i.order_id,sum(i.line_total) lot_total FROM commerce.wholesale_order_items i
  JOIN commerce.tire_lots l ON l.environment=i.environment AND l.id=i.tire_lot_id
  WHERE l.environment=$1 AND l.purchase_id=$2 GROUP BY i.order_id
), origins AS (
  SELECT t.id,'supplier'::text kind,NULL::uuid order_id,NULL::numeric lot_total
  FROM finance.matriz_ledger_transactions t WHERE t.environment=$1
    AND t.source_type='commerce.wholesale_purchase.accrual' AND t.source_id=$2::uuid::text
  UNION ALL
  SELECT t.id,'supplier_refund',NULL::uuid,NULL::numeric FROM finance.matriz_ledger_transactions t
  WHERE t.environment=$1 AND t.source_type IN ('commerce.wholesale_purchase.cancel','commerce.wholesale_purchase.adjustment')
    AND t.source_id=$2::uuid::text AND t.reversal_of_transaction_id IS NULL
  UNION ALL
  SELECT t.id,CASE WHEN t.source_type='commerce.wholesale_order.revenue_cancel' THEN 'sale_refund' ELSE 'sale' END,s.order_id,s.lot_total FROM sales s JOIN finance.matriz_ledger_transactions t
    ON t.environment=$1 AND t.source_id=s.order_id::text
    AND t.source_type IN ('commerce.wholesale_order.revenue','commerce.wholesale_order.arrival_revenue','commerce.wholesale_order.revenue_cancel') AND t.reversal_of_transaction_id IS NULL
), candidates AS (
  SELECT * FROM origins UNION
  SELECT p.payment_transaction_id,o.kind,o.order_id,o.lot_total FROM origins o
  JOIN finance.matriz_ledger_payments p ON p.environment=$1 AND p.obligation_transaction_id=o.id
    AND p.payment_kind='settlement'
)
SELECT t.id,c.kind,c.order_id,t.cash_on::text AS day,e.amount::text gross,c.lot_total::text,
  COALESCE((SELECT sum(s.amount) FROM finance.purchase_cash_shares s WHERE s.environment=t.environment
    AND s.transaction_id=t.id AND s.purchase_id<>$2),0)::text other_external,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.participant_id,'value',s.amount) ORDER BY s.participant_id)
    FROM finance.purchase_cash_shares s WHERE s.environment=t.environment AND s.transaction_id=t.id AND s.purchase_id=$2),'[]') allocations
FROM candidates c JOIN finance.matriz_ledger_transactions t ON t.environment=$1 AND t.id=c.id
JOIN finance.matriz_ledger_entries e ON e.environment=t.environment AND e.transaction_id=t.id AND e.account_code='cash'
 AND e.side=CASE WHEN c.kind IN ('sale','supplier_refund') THEN 'debit' ELSE 'credit' END
WHERE t.cash_on IS NOT NULL AND NOT EXISTS(SELECT FROM finance.matriz_ledger_transactions r
  WHERE r.environment=t.environment AND r.reversal_of_transaction_id=t.id)
ORDER BY t.cash_on,t.id`;

export async function readPurchaseSharing(db:Reader,environment:MatrizEnvironment,id:string) {
  const params=[environment,id];
  const p=(await db.query<Purchase>(`SELECT p.id,p.total_amount,p.status,p.payment_status,
    (p.purchased_at AT TIME ZONE 'America/Sao_Paulo')::date::text purchased_on,
    COALESCE(s.revision,0) revision,COALESCE(s.participants,'[]') participants,COALESCE(s.stock_allocations,'{}') stock_allocations,
    l.id lot_id,l.lot_number::text,l.quantity_on_hand,COALESCE(l.accepted_quantity,l.ordered_quantity) quantity
    FROM commerce.wholesale_purchases p LEFT JOIN finance.purchase_sharing s ON s.environment=p.environment AND s.purchase_id=p.id
    LEFT JOIN commerce.tire_lots l ON l.environment=p.environment AND l.purchase_id=p.id WHERE p.environment=$1 AND p.id=$2`,params)).rows[0];
  if (!p) throw Error('Compra não encontrada.');
  const flows=(await db.query<Flow>(flowsSql,params)).rows;
  const movements=p.lot_id?(await db.query<Movement>(`SELECT id,source,quantity_delta,
    (occurred_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS day,order_id
    FROM commerce.tire_lot_movements WHERE environment=$1 AND lot_id=$2 ORDER BY occurred_at,created_at,id`,[environment,p.lot_id])).rows:[];
  const settlements=(await db.query<Settlement>(`SELECT t.id,t.metadata->>'participant_id' participant_id,t.cash_on::text AS day,
    t.amount::text,t.metadata->>'direction' direction,COALESCE(t.metadata->>'purpose','purchase') purpose,EXISTS(SELECT FROM finance.matriz_ledger_transactions r
      WHERE r.environment=t.environment AND r.reversal_of_transaction_id=t.id) reversed
    FROM finance.matriz_ledger_transactions t WHERE t.environment=$1 AND t.source_type='finance.purchase_share.settlement'
      AND t.metadata->>'purchase_id'=$2 ORDER BY t.cash_on,t.created_at`,params)).rows;
  const total=cents(p.total_amount);
  const split=p.participants.map(person=>{
    const external=(kind:Flow['kind'])=>flows.filter(f=>f.kind===kind).reduce((n,f)=>
      n+cents(f.allocations.find(a=>a.id===person.id)?.value??0),0);
    const transfers=settlements.filter(s=>s.participant_id===person.id && s.purpose==='purchase' && !s.reversed)
      .reduce((n,s)=>n+(s.direction==='in'?1:-1)*cents(s.amount),0);
    const cost=shareCents(person,total),paid=external('supplier')-external('supplier_refund');
    return {...person,cost:cost/100,paid_supplier:paid/100,received_sales:(external('sale')-external('sale_refund'))/100,
      reimbursements:transfers/100,remaining_contribution:(cost-paid-transfers)/100};
  });
  const storeCost=total-split.reduce((n,s)=>n+cents(s.cost),0);
  const hasShares=flows.some(f=>f.allocations.length>0);
  return {...p,flows,movements,settlements,participants:split,store_cost:storeCost>=0?storeCost/100:null,
    supplier_cash:flows.filter(f=>f.kind==='supplier').reduce((n,f)=>n+cents(f.gross)-f.allocations.reduce((v,a)=>v+cents(a.value),0),0)/100,
    shared:!!p.participants.length || hasShares};
}
