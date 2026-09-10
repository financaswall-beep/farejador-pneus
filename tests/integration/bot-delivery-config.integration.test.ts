import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres';
vi.mock('../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test'}}));
vi.mock('../../src/persistence/db.js',()=>({pool:{}}));
vi.mock('../../src/parceiro/queries.js',()=>({upsertPartnerCustomerWithClient:vi.fn()}));
vi.mock('../../src/shared/geo/google-maps.js',async original=>({
  ...await original<typeof import('../../src/shared/geo/google-maps.js')>(),
  geocodeAddress:vi.fn().mockResolvedValue({lat:-22.87,lng:-42.99,confidence:'ROOFTOP'}),
}));
import { getBotDeliveryConfig,saveBotDeliveryConfig } from '../../src/admin/painel/bot-delivery-config.js';
import { deliveryProducts,simulateBotDelivery } from '../../src/admin/painel/bot-delivery-simulation.js';
import { assertRequiredSchema } from '../../src/persistence/required-schema.js';
import type { DeliverySettings } from '../../src/atendente-v2/matriz-delivery-settings.js';
let db:IntegrationDb;
const settings:DeliverySettings={delivery_enabled:true,pickup_enabled:true,radius_km:12,address:'Matriz de teste',latitude:-22.87,longitude:-42.99,
  days:[1,2,3,4,5],opens_at:'08:00',closes_at:'18:00',delivery_days:1};
beforeAll(async()=>{db=await startPostgres();});
afterAll(async()=>{if(db)await stopPostgres(db);});
describe('cadastro de entrega em Postgres isolado',()=>{
  it('migra sem ativar configuração nem preencher valores de exemplo',async()=>{
    await expect(assertRequiredSchema(db.pool)).resolves.toBeUndefined();
    expect(await getBotDeliveryConfig(db.pool)).toMatchObject({configured:false,version:0,settings:{radius_km:null,days:[]}});
    const products=await deliveryProducts('130',db.pool);
    expect(Array.isArray(products)).toBe(true);
  });
  it('primeiro salvamento concorrente aceita um único escritor e audita uma vez',async()=>{
    const results=await Promise.allSettled([saveBotDeliveryConfig(settings,0,'owner:a',db.pool),saveBotDeliveryConfig(settings,0,'owner:b',db.pool)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    expect(await getBotDeliveryConfig(db.pool)).toMatchObject({configured:true,version:1,settings});
    const audit=await db.pool.query('SELECT * FROM commerce.matriz_delivery_settings_events');
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].environment).toBe('test');
  });
  it('histórico é imutável e o ambiente prod fica sem configuração',async()=>{
    await expect(db.pool.query('DELETE FROM commerce.matriz_delivery_settings_events')).rejects.toThrow();
    await expect(db.pool.query("UPDATE commerce.matriz_delivery_settings SET environment='prod'")).rejects.toThrow();
    expect((await db.pool.query("SELECT * FROM commerce.matriz_delivery_settings WHERE environment='prod'")).rows).toEqual([]);
  });
  it('simula um rascunho pausado sem salvar configuração, reservar ou criar pedido',async()=>{
    const product=await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type)
      VALUES ('test','delivery-test','Pneu de teste','tire') RETURNING id`);
    const before=await db.pool.query("SELECT count(*) FROM commerce.orders WHERE environment='test'");
    const result=await simulateBotDelivery({address:'Endereço de teste',settings:{...settings,delivery_enabled:false},
      items:[{product_id:product.rows[0].id,quantity:1}]},db.pool);
    expect(result).toMatchObject({selected:null,reason:'delivery_paused',draft:true});
    expect(await getBotDeliveryConfig(db.pool)).toMatchObject({version:1,settings:{delivery_enabled:true}});
    expect((await db.pool.query("SELECT count(*) FROM commerce.orders WHERE environment='test'")).rows).toEqual(before.rows);
    expect((await db.pool.query('SELECT * FROM commerce.matriz_delivery_settings_events')).rows).toHaveLength(1);
  });
});
