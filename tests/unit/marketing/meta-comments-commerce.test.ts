import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createCommentLookup, type CommentToolName } from '../../../src/social-comments/commerce.js';
import { buildApplicationImport } from '../../../scripts/vehicle-application-import.js';
import { vehicleApplicationAnswer } from '../../../src/atendente-v2/vehicle-application-answer.js';

const product = (size = '130/70-13', condition = 'meia_vida') => ({
  product_id:'sku',product_code:'P1',product_name:'Pneu',product_type:'tire',brand:'Marca Exemplo',
  tire_condition:condition,short_description:null,tire_size:size,tire_position:null,intended_use:null,
  price_amount:'89.00',currency:'BRL',price_type:'regular',
});
const stock = (size = '130/70-13', condition = 'meia_vida') => ({measure:size,brand:'Marca Exemplo',
  tire_condition:condition,quantity_on_hand:3,quantity_reserved:2,unit_cost:50});
const settings = {delivery_enabled:true,pickup_enabled:true,radius_km:12,address:'Rua Exemplo, 10, São Gonçalo',
  latitude:0,longitude:0,days:[1,2,3,4,5],opens_at:'09:00',closes_at:'16:00',delivery_days:1,
  store_hours:[{day:6,opens_at:'08:00',closes_at:'13:00'}]};

// SQL real dos helpers, banco simulado: falha em qualquer escrita/consulta inesperada.
function database(data: {products?:unknown[];stock?:unknown[];applications?:unknown[];vehicles?:unknown[];fitments?:unknown[];settings?:unknown;policies?:unknown[]} = {}) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (['BEGIN READ ONLY',"SET LOCAL statement_timeout = '5s'",'COMMIT','ROLLBACK'].includes(sql)) return {rows:[]};
    if (!sql.trim().startsWith('SELECT')) throw new Error('Escrita inesperada');
    expect(values?.[0]).toBe('test');
    if (sql.includes('FROM commerce.products')) return {rows:data.products ?? []};
    if (sql.includes('FROM commerce.wholesale_stock')) return {rows:data.stock ?? []};
    if (sql.includes('resolve_vehicle_model')) return {rows:data.vehicles ?? []};
    if (sql.includes('FROM commerce.vehicle_fitments')) return {rows:data.fitments ?? []};
    if (sql.includes('FROM commerce.vehicle_measure_applications')) return {rows:data.applications ?? []};
    if (sql.includes('FROM commerce.matriz_delivery_settings')) return {rows:data.settings
      ? [{settings:data.settings,version:7,updated_at:'2026-09-15'}] : []};
    if (sql.includes('FROM commerce.store_policies')) return {rows:data.policies ?? []};
    throw new Error('Consulta inesperada');
  });
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({query,release});
  return {query,release,connect,lookup:createCommentLookup({connect} as unknown as Pool,'test')};
}

describe('consultas públicas comerciais sem efeitos em atendimento/estoque', () => {
  it.each(['130/70-13','175/65R14'])('consulta pneu %s com saldo vendável, preço e sem exigir veículo', async size => {
    const db = database({products:[product(size)],stock:[stock(size)]});
    const result: any = await db.lookup('consultar_pneu',{medida:size});
    expect(result).toMatchObject({catalogo_encontrado:true,produtos:[{medida:size,disponivel:true,preco:89,condicao:'meia_vida'}]});
    expect(JSON.stringify(result)).not.toMatch(/unit_cost|quantity|product_id|quantity_reserved|cost_missing|quantity_on_hand/);
    expect(db.query.mock.calls[0]![0]).toBe('BEGIN READ ONLY');
    expect(db.query.mock.calls.at(-1)![0]).toBe('COMMIT');
    expect(db.release).toHaveBeenCalledWith(false);
    expect(db.query.mock.calls.some(([sql])=>sql.includes('vehicle'))).toBe(false);
  });

  it('saldo reservado não aparece disponível e condição nova não usa saldo meia-vida', async () => {
    const db = database({products:[product(),product('130/70-13','novo')],stock:[{...stock(),quantity_reserved:3}]});
    const result: any = await db.lookup('consultar_pneu',{medida:'130 70 13'});
    expect(result.produtos).toHaveLength(2);
    expect(result.produtos.every((p:any)=>p.disponivel === false)).toBe(true);
    expect(new Set(result.produtos.map((p:any)=>p.condicao))).toEqual(new Set(['novo','meia_vida']));
  });

  it('propaga condição e marca como parâmetros, sem mudar ou misturar ambientes', async () => {
    const db = database();
    await db.lookup('consultar_pneu',{medida:'130/70-13',condicao:'novo',marca:'Marca Exemplo'});
    const [sql,values] = db.query.mock.calls.find(([sql])=>sql.includes('FROM commerce.products'))!;
    expect(sql).toContain('p.tire_condition =');
    expect(sql).toContain('p.brand ILIKE');
    expect(values).toEqual(['test','Marca Exemplo','novo']);
  });

  it('não transforma bloqueio de custo ou duplicidade em estoque zerado', async () => {
    for (const rows of [[{...stock(),unit_cost:null}],[stock(),stock()]]) {
      const db = database({products:[product()],stock:rows});
      const result: any = await db.lookup('consultar_pneu',{medida:'130/70-13'});
      expect(result.produtos[0].disponivel).toBeNull();
      expect(JSON.stringify(result)).not.toContain('unit_cost');
    }
  });

  it('falta de cadastro não vira declaração de falta física nem preço inventado', async () => {
    const db = database({stock:[stock()]});
    expect(await db.lookup('consultar_pneu',{medida:'130/70-13'})).toMatchObject({catalogo_encontrado:false,produtos:[]});
    const withoutPrice = database({products:[{...product(),price_amount:null}],stock:[stock()]});
    expect(await withoutPrice.lookup('consultar_pneu',{medida:'130/70-13'}))
      .toMatchObject({produtos:[{disponivel:true,preco:null}]});
  });

  it('bloqueia ferramenta de escrita e argumentos privados antes de obter conexão', async () => {
    const db = database();
    await expect(db.lookup('criar_pedido' as CommentToolName,{})).rejects.toThrow('comment_tool_not_allowed');
    await expect(db.lookup('consultar_loja',{contact_id:'123'})).rejects.toThrow();
    await expect(db.lookup('consultar_pneu',{medida:'',environment:'prod'})).rejects.toThrow();
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('retorna erro neutro, desfaz transação e descarta conexão quando rollback falha', async () => {
    const db = database();
    db.query.mockImplementation(async (sql:string) => {
      if (sql.startsWith('SELECT') || sql === 'ROLLBACK') throw new Error('secret SQL password');
      return {rows:[]};
    });
    const result = await db.lookup('consultar_pneu',{medida:'130/70-13'});
    expect(result).toMatchObject({erro:'consulta_indisponivel'});
    expect(JSON.stringify(result)).not.toMatch(/secret|password|disponivel.*false/);
    expect(db.query).toHaveBeenCalledWith('ROLLBACK');
    expect(db.release).toHaveBeenCalledWith(true);
  });
});

const catalog = buildApplicationImport().filter(r => r.status === 'verified').map(r => r.application);
const applications = catalog.map(a => ({...a,vehicle_type:'motorcycle',reference:a}));
describe('compatibilidade pública usa referências aprovadas e anos', () => {
  it('prioriza vínculo aprovado do SKU e esconde custos e IDs do resultado comercial', async () => {
    const db = database({applications,stock:[stock()],vehicles:[{vehicle_model_id:'v1',make:'Yamaha',model:'NMAX',
      variant:null,year_start:2020,year_end:2026,displacement_cc:160}],fitments:[{
      vehicle_model_id:'v1',product_id:'sku',product_name:'Pneu',brand:'Marca Exemplo',tire_condition:'meia_vida',
      tire_size:'130/70-13',year_start:2020,year_end:2026,position:'rear',is_oem:true,source:'manual',
      confidence_level:'1.00',current_price:'89.00',
    }]});
    const args = {tipo_veiculo:'motorcycle',modelo:'NMAX',posicao:'rear'};
    const result: any = await db.lookup('consultar_veiculo',{...args,ano:2025});
    expect(result).toMatchObject({encontrado:true,estoque_consultado:true,produtos:[{medida:'130/70-13',
      posicao:'rear',condicao:'meia_vida',disponivel:true,preco:89}]});
    expect(db.query.mock.calls.some(([sql])=>sql.includes('vehicle_measure_applications'))).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/product_id|unit_cost|total_stock|vehicle_model_id/);
    const missingYear: any = await db.lookup('consultar_veiculo',args);
    expect(missingYear).toMatchObject({precisa_confirmar_ano:true,precisa_confirmar_posicao:false,estoque_consultado:false,produtos:[]});
  });

  it('NMAX traseiro já resolve 130/70-13 e consulta saldo sem perguntar ano de novo', async () => {
    const db = database({applications,products:[product()],stock:[stock()]});
    const result: any = await db.lookup('consultar_veiculo',{tipo_veiculo:'motorcycle',modelo:'NMAX',posicao:'rear'});
    expect(result).toMatchObject({encontrado:true,precisa_confirmar_ano:false,precisa_confirmar_posicao:false,estoque_consultado:true});
    expect(result.consultas_estoque[0]).toMatchObject({medida_consultada:'130/70-13',produtos:[{disponivel:true}]});
    const [sql,values] = db.query.mock.calls.find(([s])=>s.includes('FROM commerce.products'))!;
    expect(sql).toContain('ts.position');
    expect(values).toContain('rear');
  });

  it.each([2016,2022])('inclui o ano %i da Twister e conserva referência radial', async year => {
    const db = database({applications});
    const result: any = await db.lookup('consultar_veiculo',{tipo_veiculo:'motorcycle',modelo:'CB250F',ano:year,posicao:'rear'});
    expect(result.estoque_consultado).toBe(true);
    expect(result.aplicacoes.some((a:any)=>a.medida==='140/70R17')).toBe(true);
  });

  it('ano fora da faixa e versão ambígua não procuram estoque de outra geração', async () => {
    const db = database({applications});
    const result: any = await db.lookup('consultar_veiculo',{tipo_veiculo:'motorcycle',modelo:'CB250F',ano:2030,posicao:'rear'});
    expect(result).toMatchObject({encontrado:true,precisa_confirmar_medida:true,estoque_consultado:false});
    const ambiguous: any = await db.lookup('consultar_veiculo',{tipo_veiculo:'motorcycle',modelo:'Fazer 150',ano:2025,posicao:'front'});
    expect(ambiguous).toMatchObject({precisa_confirmar_modelo_versao:true,estoque_consultado:false});
    expect(db.query.mock.calls.some(([sql])=>sql.includes('FROM commerce.products'))).toBe(false);
  });

  it('carro usa cadastro de carro, não fallback fixo nem aplicação de moto homônima', async () => {
    const reference = {...catalog[0]!,make:'Marca',model:'Carro Exemplo',reference_model:'Carro Exemplo',
      vehicle_type:'car' as const,position:'front' as const,tire_size:'175/65R14',display_measure:'175/65-14',
      year_start:2010,year_end:2020,year_optional:false};
    const db = database({applications:[{...reference,reference},...applications],
      products:[product('175/65R14')],stock:[stock('175/65R14')]});
    const result: any = await db.lookup('consultar_veiculo',{tipo_veiculo:'car',modelo:'Carro Exemplo',ano:2015,posicao:'front'});
    expect(result).toMatchObject({encontrado:true,estoque_consultado:true});
    expect(db.query.mock.calls.find(([sql])=>sql.includes('vehicle_measure_applications'))?.[1]).toEqual(['test',null,'car']);
    expect(db.query.mock.calls.some(([sql])=>sql.includes('resolve_vehicle_model'))).toBe(false);
    expect(vehicleApplicationAnswer({environment:'test',moto_modelo:'NMAX',posicao_pneu:'rear'},undefined,'car')).toBeNull();
    expect(vehicleApplicationAnswer({environment:'test',moto_modelo:'NMAX',posicao_pneu:'rear'},catalog,'car')).toBeNull();
  });
});

describe('dados públicos da loja', () => {
  it('prioriza endereço e horários atuais, sem expor desconto interno ou horário de entrega', async () => {
    const db = database({settings,policies:[
      {policy_key:'horario_funcionamento',policy_value:'antigo'},
      {policy_key:'endereco',policy_value:'endereço antigo'},
      {policy_key:'desconto_maximo',policy_value:{pct:10}},
      {policy_key:'formas_pagamento_aceitas',policy_value:['pix','dinheiro']},
    ]});
    const result: any = await db.lookup('consultar_loja',{});
    expect(result).toMatchObject({entrega_habilitada:true,retirada_habilitada:true});
    expect(result.politicas.find((p:any)=>p.chave === 'endereco').valor).toBe(settings.address);
    expect(result.politicas.find((p:any)=>p.chave === 'horario_funcionamento').valor).toContain('sábado: 08:00 às 13:00');
    expect(JSON.stringify(result)).not.toMatch(/16:00|desconto_maximo|endereço antigo|latitude|longitude/);
  });
  it('cadastro de funcionamento ausente não usa a janela de entregas', async () => {
    const db = database({settings:{...settings,store_hours:null}});
    const result: any = await db.lookup('consultar_loja',{});
    expect(result.politicas.find((p:any)=>p.chave === 'horario_funcionamento').valor).toContain('não cadastrado');
    expect(JSON.stringify(result)).not.toContain('16:00');
  });
});
