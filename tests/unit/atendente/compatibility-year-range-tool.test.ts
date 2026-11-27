import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  PHOTO_REQUESTS: false, DELIVERY_FREIGHT_FROM_PIN: false, FAREJADOR_ENV: 'test',
  WHOLESALE_UNIFIED_STOCK: true, ROUTING_GEO: false,
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  PARTNER_DATABASE_URL: 'postgresql://test:test@localhost:5432/test', DATABASE_SSL: false,
}));
vi.mock('../../../src/shared/config/env.js', () => ({ env: config }));
vi.mock('../../../src/atendente-v2/delivery-quote-routing.js', () => ({
  fillCityFromPin: async (_db: unknown, _env: unknown, _conv: unknown, context: unknown) => context,
}));
vi.mock('../../../src/atendente-v2/channel-pricing.js', () => ({
  applyMatrizPricesToCompatibility: async () => {},
  applyMatrizPricesToProducts: async () => {},
}));

import { manufacturerApplicationSeed } from '../../../src/shared/vehicle-tire-applications.js';
import { buildApplicationImport } from '../../../scripts/vehicle-application-import.js';
import { executeTool } from '../../../src/atendente-v2/tools.js';
import { carFitmentReplyNudge } from '../../../src/atendente-v2/car-fitment-reply.js';

const vehicle = {
  vehicle_model_id: 'v1', make: 'Honda', model: 'CB 250F Twister', variant: null,
  year_start: 2016, year_end: 2022, displacement_cc: 250,
};
const fitment = {
  vehicle_model_id: 'v1', product_id: 'p1', product_name: 'Pneu cadastrado', brand: 'Pirelli',
  tire_condition: 'novo', tire_size: '140/70R17', position: 'rear', fitment_position: 'rear',
  year_start: 2016, year_end: 2022, fitment_year_start: 2016, fitment_year_end: 2022,
  is_oem: true, source: 'manual', fitment_source: 'manual', confidence_level: '1.00',
  current_price: '399.00', total_stock: 0,
};
const args = { moto_modelo: 'Twister', moto_ano: 2021, posicao_pneu: 'rear', municipio: 'Niterói' };

function database(vehicles: unknown[] = [vehicle], products: unknown[] = [fitment], stock: unknown[] = [],
  references: unknown[] = manufacturerApplicationSeed().map(a => ({ ...a, reference: a }))) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes('AS confirmed FROM unnest')) return { rows: [{confirmed: _values?.[1] === '92987bab-415c-4789-9b98-3415071230b1'}] };
    if (sql.includes('FROM core.message_attachments') && sql.includes('coordinates_lat'))
      return { rows: [{ coordinates_lat: '-22.9', coordinates_lng: '-43.1' }] };
    if (sql.includes('resolve_vehicle_model')) return { rows: vehicles };
    if (sql.includes('vehicle_fitments') || sql.includes('find_compatible_tires')) return { rows: products };
    if (sql.includes('vehicle_measure_applications')) return { rows: references };
    if (sql.includes('FROM commerce.products') || sql.includes('search_products') || sql.includes('commerce.product_full')) return { rows: [] };
    if (sql.includes('wholesale_stock')) return { rows: stock };
    if (sql.includes('FROM commerce.geo_resolutions')) return { rows: [] };
    // O cenário não tem parceiro atendendo o município; a busca atual também consulta a rede.
    if (sql.includes('FROM network.unit_coverage')) return { rows: [] };
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  return { client: { query } as unknown as PoolClient, query };
}

describe.each([true, false])('buscar_compatibilidade com estoque unificado=%s', unified => {
  beforeEach(() => { config.WHOLESALE_UNIFIED_STOCK = unified; });

  it('consulta a família completa da Hilux antes do SKU genérico, mesmo sem oferta da SR', async () => {
    const versions = [
      ['SR', '265/65R17', 'Cabine Dupla'],
      ['SRX', '265/60R18', 'Cabine Dupla'],
      ['Cabine Simples Manual', '225/70R17', 'Cabine Simples'],
      ['Cabine Simples Automático', '225/70R17', 'Cabine Simples'],
    ];
    const references = versions.flatMap(([variant, measure, body]) => ['front','rear'].map(position => {
      const reference = { ...manufacturerApplicationSeed()[0]!, make: 'Toyota', model: 'Hilux ' + variant,
        reference_model: 'Hilux ' + variant, vehicle_variant: variant, aliases: ['Hilux ' + body],
        vehicle_model_id: variant === 'SRX' ? '880ccf97-a433-4e33-8bdb-f610ea50310c' : 'e91c8cef-ac13-439e-8940-8fab6c48f771',
        vehicle_type: 'car', year_start: 2025, year_end: 2025, position, tire_size: measure!,
        display_measure: measure!.replace('R','-') };
      return { ...reference, reference };
    }));
    const {client, query} = database([{ ...vehicle, model: 'Hilux', make: 'Toyota' }],
      [{ ...fitment, tire_size: '265/60-18', fitment_position: 'both', position: 'both' }], [], references);
    const run = async (modelo: string, extra = {}) => JSON.parse(await executeTool(client, 'test', 'conv',
      'buscar_compatibilidade', { tipo_veiculo: 'car', ano: 2025, modelo, ...extra }));
    for (const [model, measure] of [['Hilux SR','265/65-17'],['Hilux SRX','265/60-18']]) {
      expect(await run(model!)).toMatchObject({ consultas_de_produto: [{medida_pneu: measure}],
        precisa_localizacao: true, estoque_consultado: false, produto_confirmado: false });
    }
    expect(await run('Hilux')).toMatchObject({ total_aplicacoes: 8, precisa_confirmar_medida: true,
      precisa_confirmar_posicao: false, consultas_de_produto: [] });
    expect(await run('Hilux', {aro: 17})).toMatchObject({ precisa_confirmar_medida: true, consultas_de_produto: [] });
    expect(JSON.parse(await executeTool(client, 'test', 'conv', 'buscar_produto', {medida_pneu:'R17'})))
      .toMatchObject({precisa_confirmar_medida: true, estoque_consultado: false});
    expect(await run('Hilux', {aro: 16})).toMatchObject({ tipo_resultado: 'aro_sem_aplicacao_confirmada', precisa_confirmar_medida: true });
    expect(await run('Hilux Cabine Dupla')).toMatchObject({ precisa_confirmar_aro: true, mensagem: expect.stringContaining('R17 ou R18') });
    expect(await run('Hilux Cabine Dupla', {aro: 17})).toMatchObject({ consultas_de_produto: [{medida_pneu: '265/65-17'}] });
    expect(await run('Hilux', {aro: 18})).toMatchObject({ consultas_de_produto: [{medida_pneu: '265/60-18'}] });
    expect(await run('Hilux Cabine Simples')).toMatchObject({ consultas_de_produto: [{medida_pneu: '225/70-17'}] });
    for (const [model, ano] of [['Hilux SW4', 2025], ['Hilux SR', 2026]]) {
      expect(await run(model as string, {ano})).toMatchObject({ precisa_confirmar_medida: true, consultas_de_produto: [] });
    }
    expect(query.mock.calls.some(([sql]) => /resolve_vehicle_model|wholesale_stock|FROM commerce.products/.test(sql))).toBe(false);
    const commercial = await run('Hilux SR', {bairro: 'Centro', municipio: 'Niterói'});
    expect(commercial).toMatchObject({ consultas_estoque: [{medida_pneu: '265/65-17',resultado: {encontrado: false}}],
      estoque_consultado: true, produto_confirmado: false, produtos: [] });
    expect(query.mock.calls.some(([sql]) => sql.includes('resolve_vehicle_model'))).toBe(false);
    expect(await run('Hilux SRX', {produto_id:'92987bab-415c-4789-9b98-3415071230b1'})).toMatchObject({produto_confirmado:true,estoque_consultado:false});
    expect(await run('Hilux SRX', {produto_id:'3158acd3-07a2-4bbe-9a53-5e55959b2db1'})).toMatchObject({produto_confirmado:false});
    const proof = query.mock.calls.find(([sql]) => sql.includes('AS confirmed FROM unnest'))!;
    expect(proof[1]?.slice(2)).toEqual([2025, Array(2).fill('880ccf97-a433-4e33-8bdb-f610ea50310c'),
      ['front','rear'], Array(2).fill('265/60-18')]);
    config.ROUTING_GEO = true;
    try {
      const withPin = await run('Hilux SRX');
      expect(withPin).toMatchObject({estoque_consultado: true, consultas_estoque: [{medida_pneu: '265/60-18'}]});
      expect(query.mock.calls.some(([sql]) => sql.includes('coordinates_lat'))).toBe(true);
    } finally { config.ROUTING_GEO = false; }
  });

  it('carro com os dois eixos iguais consulta estoque de carro uma vez e não confirma o SKU pela medida', async () => {
    const base = { ...manufacturerApplicationSeed()[0]!, make: 'Fabricante A', model: 'Modelo A SR',
      reference_model: 'Modelo A SR', vehicle_variant: 'SR', vehicle_type: 'car', aliases: ['Modelo A'],
      year_start: 2020, year_end: 2024, tire_size: '265/60R18', display_measure: '265/60-18' };
    const rows = ['front','rear'].map(position => ({ ...base, position, reference: base }));
    const { client, query } = database([],[],[],rows);
    const run = async (modelo: string) => JSON.parse(await executeTool(client, 'test', 'conv',
      'buscar_compatibilidade', { modelo, tipo_veiculo: 'car', ano: 2024, bairro: 'Centro', municipio: 'Niterói' }));
    const result = await run('Modelo A SR');
    expect(result).toMatchObject({ precisa_confirmar_ano: false, precisa_confirmar_posicao: false,
      precisa_confirmar_modelo_versao: false, produto_confirmado: false, estoque_consultado: true,
      consultas_de_produto: [{ medida_pneu: '265/60-18', tipo_veiculo: 'car' }] });
    expect(query.mock.calls[0]?.[1]).toEqual(['test',null,'car']);
    expect(query.mock.calls.some(([sql, values]) => sql.includes('vehicle_measure_applications') && values?.[2]==='car')).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes("ts.vehicle_type = 'car'") && !sql.includes('resolve_vehicle_model'))).toBe(true);
    expect(await run('Modelo A')).toMatchObject({ precisa_confirmar_modelo_versao: true, consultas_de_produto: [] });
    for (const incomplete of ['Fabricante A','SR']) {
      expect(await run(incomplete)).toMatchObject({ encontrado: false, precisa_confirmar_medida: true, estoque_consultado: false });
    }
  });

  it('modelo de carro sem fonte própria pede a medida mesmo existindo referência de moto homônima', async () => {
    const { client, query } = database([],[]);
    const answer = JSON.parse(await executeTool(client,'test','conv','buscar_compatibilidade',
      { modelo: 'NMAX', tipo_veiculo: 'car', ano: 2018 }));
    expect(answer).toMatchObject({ encontrado: false, precisa_confirmar_medida: true, estoque_consultado: false });
    expect(query.mock.calls.some(([sql]) => sql.includes('wholesale_stock'))).toBe(false);
  });

  it('carro com vínculo do SKU para ambos os eixos dispensa posição; um eixo sozinho exige confirmação', async () => {
    const args = { tipo_veiculo: 'car', modelo: 'Modelo B', ano: 2021 };
    const run = async (position: string) => {
      const { client } = database([{ ...vehicle, make: 'Fabricante A', model: 'Modelo B' }],
        [{ ...fitment, position, fitment_position: position }]);
      return JSON.parse(await executeTool(client,'test','conv','buscar_compatibilidade',args));
    };
    expect(await run('both')).toMatchObject({ tipo_resultado: 'compatibilidade_cadastrada', precisa_confirmar_posicao: false });
    expect(await run('rear')).toMatchObject({ precisa_confirmar_posicao: true, precisa_confirmar_ano: false });
  });

  it('pedido dos dois eixos de carro com cobertura apenas dianteira pede a medida do outro eixo', async () => {
    const base = { ...manufacturerApplicationSeed()[0]!, make: 'Marca', model: 'Amostra',
      reference_model: 'Amostra', vehicle_type: 'car', position: 'front',
      year_start: 2020, year_end: 2023, tire_size: '265/60R18', display_measure: '265/60-18' };
    const { client } = database([{ ...vehicle, model: 'Amostra' }],[{ ...fitment, position: 'front', fitment_position: 'front' }],
      [],[{ ...base, reference: base }]);
    const result = JSON.parse(await executeTool(client,'test','conv','buscar_compatibilidade',
      { modelo: 'Amostra', tipo_veiculo: 'car', ano: 2021, posicao_pneu: 'both' }));
    expect(result).toMatchObject({ precisa_confirmar_posicao: false, precisa_confirmar_medida: true,
      produto_confirmado: false, estoque_consultado: false, consultas_de_produto: [] });
  });

  it('modelo sem categoria identificada não cai automaticamente no catálogo de moto', async () => {
    const { client, query } = database();
    expect(JSON.parse(await executeTool(client,'test','conv','buscar_compatibilidade',
      { modelo: 'Modelo genérico' }))).toMatchObject({ precisa_confirmar_tipo_veiculo: true });
    expect(query).not.toHaveBeenCalled();
  });

  it('ordena as opções pelo disponível após reservas, sem transformar a busca em estoque local confirmado', async () => {
    const { client } = database([vehicle], [
      { ...fitment, product_id: 'p-pirelli', brand: 'Pirelli', total_stock: 1 },
      { ...fitment, product_id: 'p-technic', brand: 'Technic', total_stock: 5 },
    ], [
      { measure: '140/70R17', brand: 'Pirelli', tire_condition: 'novo', quantity_on_hand: 20, quantity_reserved: 19, unit_cost: 100 },
      { measure: '140/70R17', brand: 'Technic', tire_condition: 'novo', quantity_on_hand: 5, quantity_reserved: 0, unit_cost: 100 },
    ]);
    const answer = JSON.parse(await executeTool(client, 'test', 'conv', 'buscar_compatibilidade', args));
    expect(answer.veiculos[0].produtos.map((p: { product_id: string }) => p.product_id))
      .toEqual(['p-technic', 'p-pirelli']);
    expect(answer.veiculos[0].produtos[0]).toMatchObject({ brand: 'Technic', current_price: '399.00', total_stock: 5 });
    expect(answer.precisa_localizacao).toBe(true);
  });

  it('retorna o vínculo vigente do banco antes da referência do fabricante, inclusive com estoque zerado', async () => {
    const { client, query } = database();
    const answer = JSON.parse(await executeTool(client, 'test', 'conv', 'buscar_compatibilidade', args));
    expect(query.mock.calls[0]?.[1]).toEqual(['test', 'Twister', 2021, 'motorcycle']);
    expect(answer).toMatchObject({
      tipo_resultado: 'compatibilidade_cadastrada', ano_informado: 2021,
      precisa_confirmar_ano: false, precisa_confirmar_modelo_versao: false, precisa_localizacao: true,
      veiculos: [{ year_start: 2016, year_end: 2022, produtos: [{ product_id: 'p1', total_stock: 0,
        fitment_year_start: 2016, fitment_year_end: 2022 }] }],
    });
    expect(answer).not.toHaveProperty('aplicacoes');
    expect(query.mock.calls[1]?.[1]).toEqual(unified
      ? ['test', ['v1'], 'rear', null, 2021]
      : ['test', 'v1', 'rear', 2021, 10, null]);
  });

  it('uma lacuna na referência estática não invalida vigência aprovada no banco para outra moto', async () => {
    const { client } = database([{ ...vehicle, make: 'Yamaha', model: 'NMAX', year_start: 2020, year_end: 2026 }],
      [{ ...fitment, tire_size: '130/70-13', year_start: 2020, year_end: 2026,
        fitment_year_start: 2020, fitment_year_end: 2026 }]);
    const answer = JSON.parse(await executeTool(client, 'test', 'conv', 'buscar_compatibilidade', {
      ...args, moto_modelo: 'NMAX', moto_ano: 2025,
    }));
    expect(answer.tipo_resultado).toBe('compatibilidade_cadastrada');
    expect(answer.veiculos[0].produtos[0].tire_size).toBe('130/70-13');
    expect(answer.precisa_confirmar_ano).toBe(false);
  });

  it('sem vínculo aprovado usa a faixa técnica comprovada, sem inventar SKU ou estoque', async () => {
    const { client, query } = database([vehicle], []);
    const answer = JSON.parse(await executeTool(client, 'test', 'conv', 'buscar_compatibilidade', args));
    expect(query).toHaveBeenCalled();
    expect(answer).toMatchObject({ tipo_resultado: 'aplicacao_de_medida_do_fabricante',
      precisa_confirmar_ano: false, estoque_consultado: true, produto_confirmado: false,
      consultas_de_produto: [{ medida_pneu: '140/70-17' }] });
    expect(answer).not.toHaveProperty('veiculos');
  });

  it('ano fora das faixas não recebe medida emprestada de outra geração', async () => {
    const { client } = database([], []);
    const answer = JSON.parse(await executeTool(client, 'test', 'conv', 'buscar_compatibilidade', {
      ...args, moto_modelo: 'CB250F', moto_ano: 2023,
    }));
    expect(answer).toMatchObject({ tipo_resultado: 'modelo_reconhecido_ano_nao_confirmado',
      precisa_confirmar_ano: false, precisa_confirmar_medida: true, aplicacoes: [], consultas_de_produto: [] });
  });

  it('não escolhe uma geração pelo estoque quando o cliente ainda não informou o ano', async () => {
    const { client } = database();
    const answer = JSON.parse(await executeTool(client, 'test', 'conv', 'buscar_compatibilidade', {
      moto_modelo: 'Twister', posicao_pneu: 'rear',
    }));
    expect(answer).toMatchObject({ tipo_resultado: 'compatibilidade_cadastrada_confirmar_contexto',
      precisa_confirmar_ano: true, precisa_confirmar_posicao: false });
    expect(answer).not.toHaveProperty('veiculos');
  });

  it('com o ano já informado pergunta somente a posição que falta', async () => {
    const { client } = database();
    const answer = JSON.parse(await executeTool(client, 'test', 'conv', 'buscar_compatibilidade', {
      moto_modelo: 'Twister', moto_ano: 2021,
    }));
    expect(answer).toMatchObject({ precisa_confirmar_ano: false,
      precisa_confirmar_posicao: true, precisa_confirmar_modelo_versao: false });
    expect(answer).not.toHaveProperty('veiculos');
  });

  it('não transforma pedido explícito dos dois pneus em pergunta repetida de posição', async () => {
    const { client, query } = database();
    const answer = JSON.parse(await executeTool(client, 'test', 'conv', 'buscar_compatibilidade', {
      ...args, posicao_pneu: 'both',
    }));
    expect(answer).toMatchObject({ tipo_resultado: 'compatibilidade_cadastrada',
      precisa_confirmar_ano: false, precisa_confirmar_posicao: false });
    expect(query.mock.calls[1]?.[1]?.[2]).toBeNull();
  });

  it('apresenta modelos diferentes encontrados no mesmo ano, sem escolher uma medida sozinho', async () => {
    const { client } = database([vehicle, { ...vehicle, vehicle_model_id: 'v2', model: 'Outro modelo' }],
      [fitment, { ...fitment, vehicle_model_id: 'v2', product_id: 'p2', tire_size: '150/60R17' }]);
    const answer = JSON.parse(await executeTool(client, 'test', 'conv', 'buscar_compatibilidade', args));
    expect(answer).toMatchObject({ tipo_resultado: 'compatibilidade_cadastrada_confirmar_contexto',
      precisa_confirmar_modelo_versao: true, precisa_confirmar_ano: false, precisa_confirmar_posicao: false });
    expect(answer.modelos).toHaveLength(2);
    expect(answer).not.toHaveProperty('veiculos');
  });

  it('falha do banco não é transformada em falta de estoque ou referência suficiente', async () => {
    const query = vi.fn().mockRejectedValue(new Error('database_unavailable'));
    const answer = JSON.parse(await executeTool({ query } as unknown as PoolClient,
      'test', 'conv', 'buscar_compatibilidade', args));
    expect(answer.erro).toBeDefined();
    expect(answer).not.toHaveProperty('aplicacoes');
    expect(answer).not.toHaveProperty('veiculos');
  });
  it('resolve NMAX sem SKU vinculado, consulta o estoque e preserva a exigência de localização', async () => {
    const query = vi.fn(async (sql:string) => {
      if(sql.includes('resolve_vehicle_model'))return {rows:[]};
      if(sql.includes('vehicle_measure_applications'))return {rows:buildApplicationImport()
        .filter(r=>r.status==='verified').map(({application:a})=>({...a,reference:a}))};
      if(sql.includes('FROM commerce.products')||sql.includes('commerce.product_full'))return {rows:[{
        product_id:'nmax-pneu',product_name:'Pneu Michelin',product_type:'tire',brand:'Michelin',
        tire_condition:'meia_vida',tire_size:'130/70-13',price_amount:'150.00',total_stock_available:0,
      }]};
      if(sql.includes('wholesale_stock'))return {rows:[]};
      throw Error('unexpected');
    });
    // O teste do caminho legado usa a mesma precificação sem alterar valores.
    const answer=JSON.parse(await executeTool({query} as unknown as PoolClient,'test','conv','buscar_compatibilidade',{
      moto_modelo:'NMAX',moto_ano:2018,posicao_pneu:'rear',
    }));
    expect(answer).toMatchObject({estoque_consultado:true,precisa_confirmar_ano:false,
      precisa_confirmar_modelo_versao:false,precisa_localizacao:true,produto_confirmado:false});
    expect(answer.produtos[0]).toMatchObject({product_id:'nmax-pneu',total_stock_available:0});
    expect(answer.consultas_estoque[0].medida_pneu).toBe('130/70-13');
    const productQuery = query.mock.calls.find(([sql]) => sql.includes('FROM commerce.products')
      || sql.includes('commerce.product_full'));
    expect(productQuery?.[0]).toContain(unified ? 'ts.position IS NULL' : 'tire_position IS NULL');
  });
});

it('uma resposta curta retoma a consulta de carro apenas quando o turno anterior pediu esclarecimento', () => {
  const context = [
    {role: 'user', content: 'Tem pneu para Hilux 2025?'},
    {role: 'assistant', content: null, tool_calls: [{type:'function', id:'c1', function: {
      name:'buscar_compatibilidade', arguments: JSON.stringify({tipo_veiculo: 'car', modelo:'Hilux', ano:2025}) } }]},
    {role:'tool', tool_call_id:'c1', content: JSON.stringify({precisa_confirmar_medida:true})},
    {role:'assistant', content:'Me diz a medida escrita na lateral?'},
  ] as const;
  const messages = JSON.parse(JSON.stringify(context));
  expect(carFitmentReplyNudge([...messages, {role:'user',content:'R17'}])).toContain('aro=17');
  expect(carFitmentReplyNudge([...messages, {role:'user',content:'cabine dupla'}])).toContain('cabine dupla');
  expect(carFitmentReplyNudge([...messages, {role:'user',content:'265/60 R18'}])).toBe('');
  expect(carFitmentReplyNudge([{role:'user',content:'R18'}])).toBe('');
  expect(carFitmentReplyNudge([...messages,{role:'user',content:'outro assunto'},{role:'assistant',content:'Quantos?'},
    {role:'user',content:'17'}])).toBe('');
});
