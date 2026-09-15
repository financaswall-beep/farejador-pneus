import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { lotSaleSchema, prorateLotCents, type LotSaleInput } from './lot-sale-schema.js';
import { resolveWholesaleBuyer } from './queries-atacado-sale-buyer.js';
import { ensureWholesaleSaleRevenue,ensureWholesaleSaleCogs,getWholesaleSaleLedgerState } from './matriz-ledger-wholesale-sales.js';
import { beginIntegrityOperation,completeIntegrityOperation,operationFingerprint,recordIntegrityEvent,moneyCents } from './stage5-integrity.js';

export async function registerLotSale(raw: LotSaleInput, actor: string, sellerId: string|null=null, db: Pool = defaultPool) {
  const input=lotSaleSchema.parse(raw), environment=env.FAREJADOR_ENV;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const operation={environment,domain:'tire_lot_sale.create',idempotencyKey:input.idempotency_key,fingerprint:operationFingerprint(input)};
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const started=await beginIntegrityOperation<{order_id:string;total_amount:number;cost:number}>(client,operation);
    if (started.replayed) { await client.query('COMMIT'); return started.result; }
    if (!env.WHOLESALE_FINANCE || !env.MATRIZ_CENTRAL_LEDGER) throw new Error('lot_sale_finance_required');
    if (input.sold_on>today) throw new Error('sold_at_future');
    const ids=input.allocations.map(row=>row.lot_id).sort();
    const lots=await client.query(`SELECT l.*,COALESCE(p.stock_applied_at,l.created_at) received_at,p.status purchase_status
      FROM commerce.tire_lots l LEFT JOIN commerce.wholesale_purchases p ON p.environment=l.environment AND p.id=l.purchase_id
      WHERE l.environment=$1 AND l.id=ANY($2::uuid[]) ORDER BY l.id FOR UPDATE OF l`,[environment,ids]);
    const allocations=input.allocations.map(row=>{
      const lot=lots.rows.find(value=>value.id===row.lot_id);
      if (!lot || lot.accepted_quantity===null || lot.purchase_status==='cancelled') throw new Error('lot_sale_lot_unavailable');
      if (lot.quantity_on_hand-lot.quantity_reserved<row.quantity) throw new Error('lot_sale_stock_changed');
      const receivedOn=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(lot.received_at));
      if (input.sold_on<receivedOn) throw new Error('lot_sale_before_receipt');
      return {...row, cost:prorateLotCents(moneyCents(Number(lot.remaining_cost)),row.quantity,lot.quantity_on_hand)};
    });
    const cost=allocations.reduce((total,row)=>total+row.cost,0);
    if (cost!==moneyCents(input.expected_cost)) throw new Error('lot_sale_cost_changed');
    const buyer=await resolveWholesaleBuyer(client,environment,{...input,items:[],created_by:actor});
    const total=moneyCents(input.amount)-moneyCents(input.discount);
    const soldAt=input.sold_on===today?new Date().toISOString():input.sold_on+'T23:59:59.999-03:00';
    const order=await client.query(`INSERT INTO commerce.wholesale_orders
      (environment,buyer_id,sold_at,total_amount,created_by,notes,payment_status,due_date,paid_at,status,
       seller_collaborator_id,is_lot_sale,lot_sale_description,lot_sale_discount,payment_method)
      VALUES ($1::env_t,$2,$3::timestamptz,0,$4,$5,$6,$7::date,
        CASE WHEN $6='paid' THEN $3::timestamptz ELSE NULL END,'confirmed',
        (SELECT id FROM network.matriz_collaborators WHERE environment=$1::env_t AND id=$8 AND revoked_at IS NULL),true,$9,$10,$11)
      RETURNING id`,[environment,buyer.id,soldAt,actor,input.notes,input.payment_status,
        input.payment_status==='pending'?input.due_date:null,sellerId,input.description,input.discount,
        input.payment_status==='paid'?input.payment_method:null]);
    const id=order.rows[0].id;
    let remaining=total, quantity=allocations.reduce((sum,row)=>sum+row.quantity,0);
    for (const allocation of allocations) {
      const revenue=prorateLotCents(remaining,allocation.quantity,quantity);
      remaining-=revenue; quantity-=allocation.quantity;
      await client.query(`INSERT INTO commerce.wholesale_order_items
        (environment,order_id,measure,brand,tire_condition,tire_lot_id,quantity,unit_price,unit_cost)
        VALUES ($1,$2,$3,'Sem marca',NULL,$4,$5::int,$6::numeric/100/$5::int,$7::numeric/100/$5::int)`,
        [environment,id,'Lote: '+input.description,allocation.lot_id,allocation.quantity,revenue,allocation.cost]);
      await client.query(`UPDATE commerce.tire_lots SET quantity_on_hand=quantity_on_hand-$3,
        remaining_cost=remaining_cost-$4::numeric/100 WHERE environment=$1 AND id=$2`,
        [environment,allocation.lot_id,allocation.quantity,allocation.cost]);
      await client.query(`INSERT INTO commerce.tire_lot_movements(environment,lot_id,source,quantity_delta,cost_delta,created_by,order_id,occurred_at)
        VALUES ($1,$2,'sale',$3,$4::numeric/100,$5,$6,$7::timestamptz)`,[environment,allocation.lot_id,-allocation.quantity,-allocation.cost,actor,id,soldAt]);
    }
    await client.query('UPDATE commerce.wholesale_orders SET total_amount=$3::numeric/100 WHERE environment=$1 AND id=$2',[environment,id,total]);
    const ledger=await getWholesaleSaleLedgerState(client,environment,id);
    await ensureWholesaleSaleRevenue(client,ledger); await ensureWholesaleSaleCogs(client,ledger);
    const result={order_id:id,total_amount:total/100,cost:cost/100};
    await recordIntegrityEvent(client,{environment,domain:'tire_lot_sale',entityTable:'commerce.wholesale_orders',entityId:id,
      eventType:'created',actorLabel:actor,idempotencyKey:input.idempotency_key,after:{...result,allocations}});
    await completeIntegrityOperation(client,operation,'commerce.wholesale_orders',id,result);
    await client.query('COMMIT'); return result;
  } catch(error) { await client.query('ROLLBACK').catch(()=>undefined);throw error; }
  finally { client.release(); }
}
