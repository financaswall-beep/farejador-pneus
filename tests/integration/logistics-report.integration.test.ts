import { randomUUID } from 'node:crypto';
import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres.js';
import { reportAddDays } from '../../src/admin/painel/report-period.js';
describe('relatório de Logística no Postgres real',()=>{
  let db:IntegrationDb,read:typeof import('../../src/admin/painel/queries-logistics-report.js').getLogisticsReport;
  let parse:typeof import('../../src/admin/painel/logistics-report-filter.js').logisticsReportQuery;
  let main:string,other:string,customer:string,product:string,tripId:string,retryId:string,newTrip:string,legacyTrip:string;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date()),from=reportAddDays(today,-2),old=reportAddDays(today,-45);
  const range={from,to:today};
  async function order(trip:string,status='delivered',unit=main,freight=20){
    const id=(await db.pool.query(`INSERT INTO commerce.orders(environment,customer_id,unit_id,total_amount,status,fulfillment_mode,delivery_address,
      trip_id,delivery_status,dispatched_at,delivered_at,scheduled_delivery_date,delivery_failure_reason)
      VALUES('test',$1,$2,$3,CASE WHEN $4='delivered' THEN 'delivered' ELSE 'open' END,'delivery','Endereço fictício',
        $5,$4,now()-interval '1 hour',CASE WHEN $4='delivered' THEN now() END,$6::date,CASE WHEN $4='failed' THEN 'Cliente ausente' END) RETURNING id`,
      [customer,unit,100+freight,status,trip,today])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price,discount_amount,matriz_unit_cost)
      VALUES('test',$1,$2,1,100,0,60)`,[id,product]);return id;
  }
  beforeAll(async()=>{
    Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test'});
    vi.resetModules();db=await startPostgres();
    ({getLogisticsReport:read}=await import('../../src/admin/painel/queries-logistics-report.js'));({logisticsReportQuery:parse}=await import('../../src/admin/painel/logistics-report-filter.js'));
    main=(await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','main','Matriz relatório') RETURNING id`)).rows[0].id;
    other=(await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','other-report','Outra unidade') RETURNING id`)).rows[0].id;
    customer=(await db.pool.query(`INSERT INTO commerce.customers(environment,name) VALUES('test','Cliente fictício relatório') RETURNING id`)).rows[0].id;
    product=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES('test','LOG-REPORT','Pneu relatório','tire','Pirelli','novo') RETURNING id`)).rows[0].id;
    tripId=(await db.pool.query(`INSERT INTO commerce.matriz_delivery_trips(environment,courier_name,km_start,started_at)
      VALUES('test','Carlos',100,now()-interval '4 hours') RETURNING id`)).rows[0].id;
    await order(tripId,'delivered',main,20);await order(tripId,'delivered',main,10);retryId=await order(tripId,'failed');await order(tripId,'delivered',other,999);
    const {closeMatrizTrip,requeueMatrizDelivery}=await import('../../src/admin/painel/queries-logistica-rotas.js');
    await closeMatrizTrip({trip_id:tripId,km_end:148,fuel_spent:76,environment:'test'},db.pool);
    await requeueMatrizDelivery({order_id:retryId,environment:'test'},db.pool);
    newTrip=(await db.pool.query(`INSERT INTO commerce.matriz_delivery_trips(environment,courier_name,started_at)
      VALUES('test','Bruno',now()-interval '30 minutes') RETURNING id`)).rows[0].id;
    await db.pool.query(`UPDATE commerce.orders SET trip_id=$2,delivery_status='delivered',delivered_at=now(),status='delivered'
      WHERE id=$1`,[retryId,newTrip]);
    const {approveMatrizTripReceipt}=await import('../../src/admin/painel/queries-logistica-comprovantes-decision.js');
    const receipt=(await db.pool.query(`INSERT INTO commerce.matriz_trip_receipts(environment,trip_id,mime,size_bytes,ai_status,workflow_status)
      VALUES('test',$1,'image/jpeg',12,'skipped','review_required') RETURNING id`,[tripId])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.matriz_trip_receipt_blobs(receipt_id,environment,bytes) VALUES($1,'test',convert_to('fake-receipt','UTF8'))`,[receipt]);
    await approveMatrizTripReceipt({receipt_id:receipt,amount:76,category:'combustivel',document_date:today,competence_month:today.slice(0,7)+'-01',
      payment_status:'paid',payment_date:today,idempotency_key:randomUUID(),actor_label:'owner:test-report',environment:'test'},db.pool);
    // Legacy fixture only in the disposable DB: same expense linked in the trip and in two receipts.
    const expense=(await db.pool.query(`INSERT INTO commerce.matriz_expenses(environment,category,amount,occurred_at,payment_status,paid_at)
      VALUES('test','combustivel',20,now(),'paid',now()) RETURNING id`)).rows[0].id;
    legacyTrip=(await db.pool.query(`INSERT INTO commerce.matriz_delivery_trips(environment,courier_name,status,started_at,ended_at,fuel_expense_id,fuel_spent)
      VALUES('test','Legado','closed',now()-interval '3 hours',now(),$1,20) RETURNING id`,[expense])).rows[0].id;
    for(let i=0;i<2;i++){
      const id=(await db.pool.query(`INSERT INTO commerce.matriz_trip_receipts(environment,trip_id,mime,size_bytes,ai_status,workflow_status)
        VALUES('test',$1,'image/jpeg',12,'skipped','review_required') RETURNING id`,[legacyTrip])).rows[0].id;
      await db.pool.query(`UPDATE commerce.matriz_trip_receipts SET workflow_status='legacy_linked',ai_expense_id=$2 WHERE id=$1`,[id,expense]);
    }
    await db.pool.query(`INSERT INTO commerce.matriz_trip_receipts(environment,trip_id,mime,size_bytes,ai_status,workflow_status)
      VALUES('test',$1,'image/jpeg',12,'skipped','review_required')`,[legacyTrip]);
    await db.pool.query(`INSERT INTO commerce.matriz_delivery_trips(environment,courier_name,status,started_at,ended_at)
      VALUES('test','Fora antes','closed',$1::timestamptz-interval '2 hours',$1::timestamptz-interval '1 second'),
        ('test','Borda','closed',$1::timestamptz-interval '2 hours',$1),
        ('test','Histórico antigo','closed',$2::timestamptz-interval '2 hours',$2),
        ('prod','Ambiente isolado','closed',now()-interval '1 hour',now())`,[from+'T03:00:00Z',old+'T15:00:00Z']);
  },180000);
  afterAll(async()=>{if(db)await stopPostgres(db);});
  it('mantém falha histórica após reentrega e calcula só frete da Matriz',async()=>{
    const r=await read(parse.parse(range),'test',db.pool),trip=r.trips.find(row=>row.id===tripId)!;
    expect(trip).toMatchObject({delivered:2,deliveries:3,occurrences:1,freight:30,expenses:76,freight_balance:-46,km:48});
    expect(r.deliveries.filter(row=>row.order_id===retryId).map(row=>row.result).sort()).toEqual(['delivered','failed']);
    expect(r.deliveries.find(row=>row.historical)).toMatchObject({reason:'Cliente ausente',scheduled:null,delivered_at:null});
    expect(r.trips.find(row=>row.id===newTrip)?.delivered).toBe(1);
  });
  it('deduplica os vínculos de despesa, mantém pendência e não inclui gasolina duas vezes',async()=>{
    const r=await read(parse.parse(range),'test',db.pool);
    expect(r.expenses.filter(row=>row.trip_id===legacyTrip)).toHaveLength(1);
    expect(r.expenses.find(row=>row.trip_id===legacyTrip)?.receipt_ids).toHaveLength(2);
    expect(r.trips.find(row=>row.id===legacyTrip)).toMatchObject({expenses:20,receipt_legacy:2,receipt_pending:1,partial:true});
    expect(r.summary).toMatchObject({expenses:96,closed_deliveries:2,cost_per_delivery:48,partial:true});
  });
  it('respeita dia de São Paulo, consulta além de 30 dias e isola ambiente',async()=>{
    const r=await read(parse.parse(range),'test',db.pool);expect(r.trips.map(row=>row.courier)).toContain('Borda');
    expect(r.trips.map(row=>row.courier)).not.toContain('Fora antes');expect(r.trips.map(row=>row.courier)).not.toContain('Ambiente isolado');
    const historical=await read(parse.parse({from:old,to:old}),'test',db.pool);expect(historical.trips.map(row=>row.courier)).toEqual(['Histórico antigo']);
    expect((await read(parse.parse(range),'prod',db.pool)).trips.map(row=>row.courier)).toEqual(['Ambiente isolado']);
  });
  it('filtros não alteram totais e a leitura não grava eventos ou despesas',async()=>{
    const counts=()=>db.pool.query(`SELECT (SELECT count(*) FROM commerce.matriz_expenses) AS expenses,(SELECT count(*) FROM audit.events) AS events`);
    const before=await counts(),r=await read(parse.parse({...range,trip:tripId,delivery:'failed',receipt:'pending'}),'test',db.pool);
    expect(r.deliveries).toHaveLength(1);expect(r.costs).toHaveLength(0);expect(r.summary.expenses).toBe(96);expect((await counts()).rows).toEqual(before.rows);
  });
});
