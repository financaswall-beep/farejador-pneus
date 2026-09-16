import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
let db: IntegrationDb;
let purchase: typeof import('../../src/admin/painel/queries-fornecedores-registro.js').registerWholesalePurchase;
let sale: typeof import('../../src/admin/painel/queries-atacado-vendas.js').registerWholesaleSale;
let car: string, moto: string;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
beforeAll(async () => {
  Object.assign(process.env, { NODE_ENV:'test', FAREJADOR_ENV:'test', DATABASE_URL:'postgres://test',
    CHATWOOT_HMAC_SECRET:'test', ADMIN_AUTH_TOKEN:'test', WHOLESALE_FINANCE:'false' });
  db=await startPostgres();
  ({registerWholesalePurchase:purchase}=await import('../../src/admin/painel/queries-fornecedores-registro.js'));
  ({registerWholesaleSale:sale}=await import('../../src/admin/painel/queries-atacado-vendas.js'));
  async function product(measure:string,type:string) {
    const p=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES('test',$1,'Pneu teste','tire','Marca teste','meia_vida') RETURNING id`,[randomUUID()])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,vehicle_type)
      VALUES('test',$1,$2,$3)`,[p,measure,type]);return p;
  }
  car=await product('195/65-15','car');moto=await product('130/70-13','motorcycle');
},180000);
afterAll(async()=>{if(db)await stopPostgres(db);});

describe('carro e moto nas operações e relatórios',()=>{
  it('separa mínimo e saldo por categoria e preserva a classificação nas correções de estoque',async()=>{
    const {setWholesaleStock}=await import('../../src/admin/painel/queries-galpao.js');
    const {listWholesaleStock}=await import('../../src/admin/painel/queries-galpao-list.js');
    const {transferWholesaleStockCondition}=await import('../../src/admin/painel/queries-stock-condition-transfer.js');
    const {correctWholesaleStockBrand}=await import('../../src/admin/painel/queries-stock-brand-correction.js');
    const p=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES('test',$1,'Variante de teste','tire','Outra marca','novo') RETURNING id`,[randomUUID()])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,vehicle_type) VALUES('test',$1,'130/70-13','car')`,[p]);
    await setWholesaleStock({environment:'test',measure:'130/70-13',brand:'Outra marca',tire_condition:'novo',quantity_on_hand:5,unit_cost:10,min_quantity:20},db.pool);
    await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost,vehicle_type)
      VALUES('test','130/70-13','Moto teste','novo',3,10,'motorcycle')`);
    await setWholesaleStock({environment:'test',measure:'130/70-13',brand:'Moto teste',tire_condition:'novo',quantity_on_hand:3,unit_cost:10,min_quantity:7},db.pool);
    const rows=await listWholesaleStock('test',db.pool);
    expect(rows.find(r=>r.brand==='Outra marca')).toMatchObject({vehicle_type:'car',min_quantity:20,replenishment_quantity_available:5});
    expect(rows.find(r=>r.brand==='Moto teste')).toMatchObject({vehicle_type:'motorcycle',min_quantity:7,replenishment_quantity_available:3});
    await transferWholesaleStockCondition({environment:'test',measure:'130/70-13',brand:'Moto teste',from_condition:'novo',
      to_condition:'meia_vida',quantity:1,reason:'Condição corrigida no teste',idempotency_key:randomUUID()},db.pool);
    await correctWholesaleStockBrand({environment:'test',measure:'130/70-13',from_brand:'Moto teste',to_brand:'Marca corrigida',
      tire_condition:'meia_vida',reason:'Marca corrigida no teste',idempotency_key:randomUUID()},db.pool);
    expect((await db.pool.query(`SELECT vehicle_type FROM commerce.wholesale_stock WHERE environment='test' AND brand='Marca corrigida'`)).rows[0].vehicle_type).toBe('motorcycle');
    expect((await db.pool.query(`SELECT vehicle_type FROM commerce.wholesale_stock_movements WHERE environment='test' AND brand='Moto teste' AND op='delete'`)).rows[0].vehicle_type).toBe('motorcycle');
    await db.pool.query(`DELETE FROM commerce.wholesale_stock WHERE environment='test' AND brand IN ('Outra marca','Moto teste','Marca corrigida')`);
    await db.pool.query(`DELETE FROM commerce.products WHERE id=$1`,[p]);
  });
  it('compra e vende itens mistos sem duplicar documentos, custo, saldo ou pagamento',async()=>{
    const input={environment:'test' as const,new_supplier:{name:'Fornecedor de teste'},created_by:'test',
      idempotency_key:randomUUID(),receipt_status:'received' as const,
      items:[{measure:'195/65-15',brand:'Marca teste',tire_condition:'meia_vida',vehicle_type:'car' as const,quantity:2,unit_cost:100},
        {measure:'130/70-13',brand:'Marca teste',tire_condition:'meia_vida',vehicle_type:'motorcycle' as const,quantity:3,unit_cost:50}]};
    const p=await purchase(input,db.pool);expect((await purchase(input,db.pool)).purchase_id).toBe(p.purchase_id);
    const {purchaseReportQuery}=await import('../../src/admin/painel/purchase-report-period.js');
    const {getPurchaseReport}=await import('../../src/admin/painel/queries-purchase-report.js');
    const f=purchaseReportQuery.parse({from:today(),to:today(),compare:'false'});
    const all=await getPurchaseReport(f,true,'test',db.pool);
    expect(all.summary).toMatchObject({purchases:1,quantity:5,value:350});
    const onlyCar=await getPurchaseReport({...f,vehicle_type:'car'},true,'test',db.pool);
    expect(onlyCar.summary).toMatchObject({purchases:1,quantity:2,value:200,paid:null,open:null});
    expect(onlyCar.products).toHaveLength(1);expect(onlyCar.products[0]?.vehicle_type).toBe('car');
    const order=await sale({environment:'test',new_customer:{name:'Cliente teste'},created_by:'test',idempotency_key:randomUUID(),
      items:input.items.map(i=>({...i,quantity:1,unit_price:i.vehicle_type==='car'?150:90}))},db.pool);
    const snapshots=(await db.pool.query(`SELECT vehicle_type,quantity FROM commerce.wholesale_order_items WHERE order_id=$1 ORDER BY vehicle_type`,[order.order_id])).rows;
    expect(snapshots).toEqual([{vehicle_type:'car',quantity:1},{vehicle_type:'motorcycle',quantity:1}]);
    const {salesReportQuery}=await import('../../src/admin/painel/sales-report-period.js');
    const {getSalesReport}=await import('../../src/admin/painel/queries-sales-report.js');
    const sf=salesReportQuery.parse({from:today(),to:today(),compare:'false'});
    expect((await getSalesReport(sf,true,'test',db.pool)).summary).toMatchObject({orders:1,tires:2,revenue:240,cost:150});
    expect((await getSalesReport({...sf,vehicle_type:'car'},true,'test',db.pool)).summary).toMatchObject({orders:1,tires:1,revenue:150,cost:100});
    const {getStockCosts}=await import('../../src/admin/painel/queries-stock-costs.js');
    expect((await getStockCosts(db.pool,'car')).summary).toMatchObject({quantity:1,capital:100});
    const before=(await db.pool.query(`SELECT count(*)::int n FROM commerce.wholesale_purchases WHERE environment='test'`)).rows;
    await expect(purchase({...input,new_supplier:{name:'Outro '+randomUUID()},idempotency_key:randomUUID(),items:[{...input.items[0]!,vehicle_type:'motorcycle'}]},db.pool)).rejects.toThrow(/vehicle_type_conflict/);
    expect((await db.pool.query(`SELECT count(*)::int n FROM commerce.wholesale_purchases WHERE environment='test'`)).rows).toEqual(before);
    await expect(db.pool.query(`UPDATE commerce.wholesale_order_items SET vehicle_type='motorcycle' WHERE order_id=$1 AND vehicle_type='car'`,[order.order_id])).rejects.toThrow(/immutable/);
  });

  it('uma conversa com duas medidas aparece nos dois tipos, mas só converte o tipo comprado',async()=>{
    const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id) VALUES('test',9867001) RETURNING id`)).rows[0].id;
    const conversation=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at,last_activity_at)
      VALUES('test',9867001,1,$1,'open',now(),now()) RETURNING id`,[contact])).rows[0].id;
    for(const measure of ['195/65-15','195/65R15','130/70-13']) {
      await db.pool.query(`INSERT INTO analytics.conversation_facts(environment,conversation_id,fact_key,fact_value,truth_type,source,extractor_version,observed_at)
        VALUES('test',$1,'medida_consultada',$2::jsonb,'observed','test',$3,now())`,[conversation,JSON.stringify(measure),randomUUID()]);
      await db.pool.query(`INSERT INTO ops.bot_stock_searches(environment,conversation_id,search_key,tool_name,measure,municipality,filters,stores)
        VALUES('test',$1,$2,'buscar_produto',$3,'Niterói','{}','[{"id":"matriz","name":"Matriz","available":false}]')`,[conversation,randomUUID(),measure]);
    }
    const order=(await db.pool.query(`INSERT INTO commerce.orders(environment,contact_id,source_conversation_id,total_amount,status,fulfillment_mode)
      VALUES('test',$1,$2,90,'confirmed','pickup') RETURNING id`,[contact,conversation])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price,tire_condition)
      VALUES('test',$1,$2,1,90,'meia_vida')`,[order,moto]);
    const {demandReportQuery}=await import('../../src/admin/painel/demand-report-filter.js');
    const {readDemandSnapshot}=await import('../../src/admin/painel/demand-report-data.js');
    const {buildDemandReport}=await import('../../src/admin/painel/queries-demand-report.js');
    const f=demandReportQuery.parse({from:today(),to:today(),compare:'false'});
    for(const [type,measures,orders] of [['all',2,1],['car',1,0],['motorcycle',1,1],['unknown',0,0]] as const){
      const filter={...f,vehicle_type:type},r=buildDemandReport(await readDemandSnapshot(filter,'test',db.pool),filter);
      expect(r.summary.conversations).toBe(type==='unknown'?0:1);expect(r.summary.orders).toBe(orders);
      expect(r.measures_summary.consultations).toBe(measures);
    }
    const {shortageReportQuery}=await import('../../src/admin/painel/shortage-report-filter.js');
    const {readShortageSnapshot}=await import('../../src/admin/painel/shortage-report-data.js');
    const shortages=await readShortageSnapshot(shortageReportQuery.parse({from:today(),to:today(),vehicle_type:'car'}),'test',db.pool);
    expect(shortages.traces).toHaveLength(2);expect(shortages.products.every(p=>p.id===car)).toBe(true);
    const {getBotShortages,getBotShortageConsultations}=await import('../../src/admin/painel/queries-bot-faltas.js');
    expect(await getBotShortages({from:today(),to:today(),vehicle_type:'car'},'test',db.pool)).toMatchObject({consultations:1,shortages:1,measure_count:1});
    expect((await getBotShortageConsultations({from:today(),to:today(),vehicle_type:'car',measure:'195/65-15'},'test',db.pool)).total).toBe(2);
  });
  it('registra procura por medida cadastrada sem SKU e não adivinha a categoria de um SKU desconhecido',async()=>{
    const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id) VALUES('test',9867002) RETURNING id`)).rows[0].id;
    const conversation=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at,last_activity_at)
      VALUES('test',9867002,1,$1,'open',now(),now()) RETURNING id`,[contact])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.catalog_measure_registrations(environment,measure,source,vehicle_type)
      VALUES('test','205/60-16','test','car')`);
    const search=async(measure:string)=>(await db.pool.query(`INSERT INTO ops.bot_stock_searches(environment,conversation_id,search_key,tool_name,measure,filters,stores)
      VALUES('test',$1,$2,'buscar_produto',$3,'{}','[]') RETURNING id,vehicle_type`,[conversation,randomUUID(),measure])).rows[0];
    const first=await search('205/60R16');expect(first.vehicle_type).toBe('car');
    expect((await search('225/40R18')).vehicle_type).toBeNull();
    const product=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES('test',$1,'Sem classificação','tire','Marca teste','novo') RETURNING id`,[randomUUID()])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES('test',$1,'205/60-16')`,[product]);
    expect((await search('205/60R16')).vehicle_type).toBeNull();
    expect((await db.pool.query('SELECT vehicle_type FROM ops.bot_stock_searches WHERE id=$1',[first.id])).rows[0].vehicle_type).toBe('car');
  });
});
