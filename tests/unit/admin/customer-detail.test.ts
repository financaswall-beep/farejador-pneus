import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
const { cachedReverseGeocode } = vi.hoisted(() => ({ cachedReverseGeocode:vi.fn() }));
vi.mock('../../../src/persistence/db.js',() => ({ pool:{} }));
vi.mock('../../../src/shared/config/env.js',() => ({ env:{ GOOGLE_MAPS_API_KEY:'test-google-key' } }));
vi.mock('../../../src/shared/geo/geo-cache.js',() => ({ cachedReverseGeocode }));
import { getCustomerDetail } from '../../../src/admin/painel/customer-detail.js';
import { customerOrdersSql, customerProfileSql } from '../../../src/admin/painel/customer-detail-sql.js';

const profile = { name:'Ana Silva',phone:'+5521999991234',email:null,created_at:'2026-09-07',
  origin:'Loja parceira',unit_name:'Loja A',unit_id:'unit-a',address:'Rua Teste, 10' };
const history = { purchases:3,total_spent:300,avg_ticket:100,last_purchase_at:'2026-09-07',
  history_total:12,last_address:'Rua da entrega, 20',last_unit_name:'Loja A',orders:[{ id:'order-1' }] };
describe('ficha individual de cliente',() => {
  it('não consulta pedidos se o cadastro não existe no ambiente',async () => {
    const query = vi.fn().mockResolvedValue({ rows:[] });
    expect(await getCustomerDetail('test','parceiro','id',{}, { query } as unknown as Pool)).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('usa vínculo por ID e unidade e resume compras, sem gravar cadastro',async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows:[profile] }).mockResolvedValueOnce({ rows:[history] });
    const detail = await getCustomerDetail('test','parceiro','id',{ offset:10,limit:10 },{ query } as unknown as Pool);
    expect(detail?.customer).toMatchObject({ name:'Ana Silva',is_vip:true,address:'Rua da entrega, 20',address_source:'order' });
    expect(detail?.summary).toMatchObject({ purchases:3,total_spent:300,avg_ticket:100 });
    expect(detail?.next_offset).toBe(11);
    expect(query.mock.calls[1]?.[1]).toEqual(['test','id',10,10,'unit-a']);
    for (const call of query.mock.calls) expect(call[0]).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
  it('mostra endereço do cadastro quando não houve entrega, sem presumir VIP',async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows:[profile] }).mockResolvedValueOnce({
      rows:[{ ...history,purchases:0,total_spent:0,avg_ticket:0,history_total:0,orders:[],last_address:null }],
    });
    const detail = await getCustomerDetail('prod','parceiro','id',{}, { query } as unknown as Pool);
    expect(detail?.customer).toMatchObject({ is_vip:false,address:'Rua Teste, 10',address_source:'customer' });
    expect(detail?.next_offset).toBeNull();
  });
  it('mostra o último pino do lead como estimativa, sem transformá-lo em endereço confirmado',async () => {
    cachedReverseGeocode.mockResolvedValueOnce({
      municipio:'Maricá',neighborhood:'Inoã',formattedAddress:'Rodovia Amaral Peixoto, Inoã, Maricá - RJ',
    });
    const leadProfile={ ...profile,address:null,origin:'Instagram',unit_id:null,unit_name:null };
    const leadHistory={ ...history,purchases:0,total_spent:0,avg_ticket:0,history_total:0,
      orders:[],last_address:null,last_unit_name:null };
    const query=vi.fn()
      .mockResolvedValueOnce({ rows:[leadProfile] })
      .mockResolvedValueOnce({ rows:[leadHistory] })
      .mockResolvedValueOnce({ rows:[{ source:'shared_pin',coordinates_lat:'-22.9301',coordinates_lng:'-42.8204',observed_at:'2026-09-07',fact_value:null }] });
    const detail=await getCustomerDetail('prod','chatwoot','contact-1',{}, { query } as unknown as Pool);
    expect(detail?.customer).toMatchObject({
      address:null,address_source:null,
      shared_location:{ label:'Inoã — Maricá',estimated_address:'Rodovia Amaral Peixoto, Inoã, Maricá - RJ',source:'shared_pin' },
    });
    expect(detail?.customer.shared_location.maps_url).toContain('-22.9301%2C-42.8204');
    expect(cachedReverseGeocode).toHaveBeenCalledWith(expect.anything(),{ lat:-22.9301,lng:-42.8204 },
      'test-google-key',{ requireFormattedAddress:true });
    expect(query.mock.calls[2]?.[1]).toEqual(['prod','contact-1']);
  });
  it('mostra localização digitada como estimativa sem criar endereço de entrega',async () => {
    cachedReverseGeocode.mockClear();
    const leadProfile={ ...profile,address:null,origin:'Instagram',unit_id:null,unit_name:null };
    const leadHistory={ ...history,purchases:0,total_spent:0,avg_ticket:0,history_total:0,
      orders:[],last_address:null,last_unit_name:null };
    const query=vi.fn()
      .mockResolvedValueOnce({ rows:[leadProfile] })
      .mockResolvedValueOnce({ rows:[leadHistory] })
      .mockResolvedValueOnce({ rows:[{ source:'typed',coordinates_lat:null,coordinates_lng:null,
        observed_at:'2026-09-08',fact_value:{ texto_informado:'Rua 43, Itaipuaçu, Maricá',
          tipo:'endereco_digitado',rua:'Rua 43',bairro:'Itaipuaçu',municipio:'Maricá' } }] });
    const detail=await getCustomerDetail('prod','chatwoot','contact-1',{}, { query } as unknown as Pool);
    expect(detail?.customer).toMatchObject({
      address:null,address_source:null,
      shared_location:{ label:'Itaipuaçu — Maricá',estimated_address:'Rua 43, Itaipuaçu, Maricá',source:'typed' },
    });
    expect(detail?.customer.shared_location.maps_url).toContain('Rua%2043%2C%20Itaipua%C3%A7u%2C%20Maric%C3%A1');
    expect(cachedReverseGeocode).not.toHaveBeenCalled();
  });
  it.each(['chatwoot','balcao','parceiro','atacado'] as const)('mantém escopo explícito em %s',source => {
    const sql = customerOrdersSql(source);
    expect(customerProfileSql[source]).toContain('c.environment=$1 AND c.id=$2');
    expect(sql).toContain('o.environment=$1');
    expect(sql).toContain('LIMIT $3 OFFSET $4');
    expect(sql).toContain('FILTER (WHERE completed)');
    expect(sql).toContain('oi.environment=$1 AND oi.order_id=page.id');
    expect(sql).not.toMatch(/phone\s*=|name\s*(=|ILIKE)/i);
  });
});
