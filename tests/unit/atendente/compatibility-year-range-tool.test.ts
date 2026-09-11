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
}));

import { executeTool } from '../../../src/atendente-v2/tools.js';

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

function database(vehicles: unknown[] = [vehicle], products: unknown[] = [fitment]) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes('resolve_vehicle_model')) return { rows: vehicles };
    if (sql.includes('vehicle_fitments') || sql.includes('find_compatible_tires')) return { rows: products };
    if (sql.includes('wholesale_stock')) return { rows: [] };
    throw new Error(`Consulta inesperada: ${sql}`);
  });
  return { client: { query } as unknown as PoolClient, query };
}

describe.each([true, false])('buscar_compatibilidade com estoque unificado=%s', unified => {
  beforeEach(() => { config.WHOLESALE_UNIFIED_STOCK = unified; });

  it('retorna o vínculo vigente do banco antes da referência do fabricante, inclusive com estoque zerado', async () => {
    const { client, query } = database();
    const answer = JSON.parse(await executeTool(client, 'test', 'conv', 'buscar_compatibilidade', args));
    expect(query.mock.calls[0]?.[1]).toEqual(['test', 'Twister', 2021]);
    expect(answer).toMatchObject({
      tipo_resultado: 'compatibilidade_cadastrada', ano_informado: 2021,
      precisa_confirmar_ano: false, precisa_confirmar_modelo_versao: false, precisa_localizacao: true,
      veiculos: [{ year_start: 2016, year_end: 2022, produtos: [{ product_id: 'p1', total_stock: 0,
        fitment_year_start: 2016, fitment_year_end: 2022 }] }],
    });
    expect(answer).not.toHaveProperty('aplicacoes');
    expect(query.mock.calls[1]?.[1]).toEqual(unified
      ? ['test', ['v1'], 'rear', null, 2021]
      : ['test', 'v1', 'rear', 2021, 10]);
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
      precisa_confirmar_ano: false, estoque_consultado: false, produto_confirmado: false,
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
});
