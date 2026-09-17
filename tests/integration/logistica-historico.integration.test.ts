import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
let db: IntegrationDb;
let api: typeof import('../../src/admin/painel/queries-logistica-historico.js');
let main: string, customer: string, product: string, pending: string, positive: string, failedOrder: string;
const range = { from: '2024-01-02', to: '2024-01-02' };
async function trip(name: string, sale = 0, cost: number | null = 0, expense = 0, receiptPending = false, fuel = false) {
  const id = (await db.pool.query(`INSERT INTO commerce.matriz_delivery_trips(environment,courier_name,status,started_at,ended_at,km_start,km_end,fuel_spent)
    VALUES('test',$1,'closed','2024-01-02T08:00:00-03:00','2024-01-02T12:00:00-03:00',100,147,$2) RETURNING id`, [name, fuel ? 9 : 0])).rows[0].id;
  if (sale) {
    const oid = (await db.pool.query(`INSERT INTO commerce.orders(environment,customer_id,unit_id,total_amount,status,fulfillment_mode,delivery_address,trip_id,delivery_status,delivered_at)
      VALUES('test',$1,$2,$3,'delivered','delivery','Endereço fictício',$4,'delivered','2024-01-02T11:00:00-03:00') RETURNING id`, [customer, main, sale, id])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price,discount_amount,matriz_unit_cost) VALUES('test',$1,$2,1,$3,0,$4)`, [oid, product, sale, cost]);
  }
  if (expense) {
    const eid = (await db.pool.query(`INSERT INTO commerce.matriz_expenses(environment,category,amount,occurred_at,payment_status,paid_at) VALUES('test',$1,$2,now(),'paid',now()) RETURNING id`, [fuel ? 'combustivel' : 'pedagio', expense])).rows[0].id;
    const rid = (await db.pool.query(`INSERT INTO commerce.matriz_trip_receipts(environment,trip_id,mime,size_bytes,ai_status,workflow_status) VALUES('test',$1,'image/jpeg',10,'skipped','review_required') RETURNING id`, [id])).rows[0].id;
    await db.pool.query(`UPDATE commerce.matriz_trip_receipts SET workflow_status='legacy_linked',ai_expense_id=$2 WHERE id=$1`, [rid, eid]);
  }
  if (receiptPending) await db.pool.query(`INSERT INTO commerce.matriz_trip_receipts(environment,trip_id,mime,size_bytes,ai_status,workflow_status) VALUES('test',$1,'image/jpeg',10,'skipped','review_required')`, [id]);
  return id;
}
beforeAll(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test', CHATWOOT_HMAC_SECRET: 'test', ADMIN_AUTH_TOKEN: 'test' });
  db = await startPostgres(); api = await import('../../src/admin/painel/queries-logistica-historico.js');
  main = (await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','main','Matriz teste') RETURNING id`)).rows[0].id;
  customer = (await db.pool.query(`INSERT INTO commerce.customers(environment,name) VALUES('test','Cliente fictício') RETURNING id`)).rows[0].id;
  product = (await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition) VALUES('test','HIST','Pneu fictício','tire','Pirelli','novo') RETURNING id`)).rows[0].id;
  await db.pool.query(`INSERT INTO commerce.matriz_expense_categories(environment,slug,label) VALUES('test','pedagio','Pedágio')`);
  positive = await trip('Positiva',200,80,20); await trip('Negativa',100,130,20);
  pending = await trip('Pendente',200,80,20,true); await trip('Sem custo',100,null); await trip('Divergente',200,80,10,false,true);
  await trip('Sem vendas A'); await trip('Sem vendas B');
  await db.pool.query(`INSERT INTO commerce.matriz_delivery_trips(environment,courier_name,status,started_at,ended_at) VALUES
    ('prod','Privada','closed','2024-01-02T12:00:00-03:00','2024-01-02T12:00:00-03:00'),
    ('test','Fora do dia','closed','2024-01-02T00:30:00Z','2024-01-02T02:59:59Z'),
    ('test','Aberta','open','2024-01-02T12:00:00-03:00',NULL)`);
  failedOrder = (await db.pool.query(`INSERT INTO commerce.orders(environment,customer_id,unit_id,total_amount,status,fulfillment_mode,delivery_address,delivery_status)
    VALUES('test',$1,$2,99,'open','delivery','Fictício','pending') RETURNING id`, [customer,main])).rows[0].id;
  await db.pool.query(`INSERT INTO audit.events(environment,domain,event_type,entity_table,entity_id,actor_label,payload_before,payload_after)
    VALUES('test','matriz_logistics','delivery_report_detached_on_trip_close','commerce.orders',$1,'system',jsonb_build_object('trip_id',$2::text,'delivery_failure_reason','Cliente ausente'),'{}')`, [failedOrder, positive]);
},180000);
afterAll(async () => { if (db) await stopPostgres(db); });
describe('Histórico de rotas no PostgreSQL real', () => {
  it('soma somente resultados conciliados, inclui prejuízo e mantém total entre páginas', async () => {
    const r = await api.listMatrizHistory(api.logisticsHistoryQuery.parse(range),'test',db.pool);
    expect(r.summary).toMatchObject({closed:7,reconciled:4,pending:3}); expect(Number(r.summary.result)).toBe(50); expect(r.rows).toHaveLength(6);
    const next = await api.listMatrizHistory(api.logisticsHistoryQuery.parse({...range,page:100}),'test',db.pool);
    expect(next.page).toBe(2); expect(next.rows).toHaveLength(1); expect(next.summary).toEqual(r.summary);
    expect(new Set([...r.rows,...next.rows].map((t:any)=>t.id)).size).toBe(7);
  });
  it('filtra conciliação, busca e responsável sem confundir sugestão com despesa', async () => {
    const p = await api.listMatrizHistory(api.logisticsHistoryQuery.parse({...range,q:'Pendente'}),'test',db.pool);
    expect(p.rows[0].id).toBe(pending); expect(Number(p.rows[0].despesas_total)).toBe(20); expect(Number(p.summary.result)).toBe(0);
    const rec = await api.listMatrizHistory(api.logisticsHistoryQuery.parse({...range,financial:'reconciled'}),'test',db.pool); expect(rec.summary.closed).toBe(4);
    const div = await api.listMatrizHistory(api.logisticsHistoryQuery.parse({...range,financial:'divergent'}),'test',db.pool); expect(div.summary.closed).toBe(1);
    const courier = await api.listMatrizHistory(api.logisticsHistoryQuery.parse({...range,courier:'name:Negativa'}),'test',db.pool); expect(Number(courier.summary.result)).toBe(-50);
  });
  it('isola ambiente, respeita data de São Paulo e preserva tentativas históricas', async () => {
    const prod = await api.listMatrizHistory(api.logisticsHistoryQuery.parse(range),'prod',db.pool); expect(prod.rows.map((t:any)=>t.courier_name)).toEqual(['Privada']);
    const deliveries = await api.listClosedTripDeliveries(positive,'test',db.pool);
    expect(deliveries.rows).toHaveLength(2); expect(deliveries.rows.find((d:any)=>d.historical)).toMatchObject({order_id:failedOrder,status:'failed',reason:'Cliente ausente',total_amount:null});
    expect((await api.listClosedTripDeliveries(positive,'prod',db.pool)).rows).toHaveLength(0);
  });
});
