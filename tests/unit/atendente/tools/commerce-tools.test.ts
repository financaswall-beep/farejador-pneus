import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  buscarCompatibilidade,
  buscarPoliticaComercial,
  buscarProduto,
  calcularFrete,
  verificarEstoque,
} from '../../../../src/atendente/tools/commerce-tools.js';
import { logger } from '../../../../src/shared/logger.js';

interface QueryCall {
  text: string;
  values: unknown[];
}

function clientWithRows(rowSets: unknown[][]): PoolClient & { calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    calls,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return { rows: rowSets.shift() ?? [] };
    },
  } as unknown as PoolClient & { calls: QueryCall[] };
}

describe('commerce tools deterministicas da Atendente', () => {
  it('buscarProduto filtra medida normalizada, marca, posicao e estoque', async () => {
    const client = clientWithRows([
      [
        {
          product_id: 'p1',
          product_code: 'PIR-175',
          product_name: 'Pirelli MT60',
          product_type: 'tire',
          brand: 'Pirelli',
          short_description: null,
          tire_size: '175/70 R17',
          tire_position: 'rear',
          intended_use: 'mixed',
          price_amount: '175.00',
          currency: 'BRL',
          price_type: 'regular',
          total_stock_available: '4',
        },
      ],
    ]);

    const result = await buscarProduto(client, {
      environment: 'test',
      medida_pneu: '175/70 R17',
      marca: 'Pirelli',
      posicao_pneu: 'rear',
      apenas_com_estoque: true,
    });

    expect(result).toEqual([
      expect.objectContaining({
        product_id: 'p1',
        total_stock_available: 4,
        price_amount: '175.00',
      }),
    ]);
    expect(client.calls[0]!.text).toContain('commerce.product_full');
    expect(client.calls[0]!.values).toContain('175/70-17');
    expect(client.calls[0]!.text).toContain('total_stock_available > 0');
  });

  it('buscarProduto exige pelo menos medida, marca ou product_code', async () => {
    const client = clientWithRows([]);

    await expect(buscarProduto(client, { environment: 'test' })).rejects.toThrow(
      'buscarProduto exige medida_pneu, marca ou product_code',
    );
    expect(client.calls).toHaveLength(0);
  });

  it('buscarProduto: posicao "both" NAO restringe tire_position (fix do 80/90-21 dianteiro)', async () => {
    // Regressao: 'both' = alias de "qualquer posicao". Sem o fix virava tire_position='both'
    // e excluia pneus de posicao unica (front/rear) mesmo com estoque na Matriz.
    const client = clientWithRows([[]]);
    await buscarProduto(client, {
      environment: 'test',
      medida_pneu: '80/90-21',
      posicao_pneu: 'both',
      apenas_com_estoque: true,
    });
    // 'OR tire_position' só aparece no FILTRO de posição (o SELECT tem 'tire_position,' com vírgula).
    expect(client.calls[0]!.text).not.toContain('OR tire_position'); // posicao nao filtra
    expect(client.calls[0]!.values).toContain('80/90-21'); // medida ainda filtra
    expect(client.calls[0]!.text).toContain('total_stock_available > 0'); // estoque ainda filtra
  });

  it('buscarProduto: posicao "rear" SEGUE restringindo tire_position', async () => {
    const client = clientWithRows([[]]);
    await buscarProduto(client, { environment: 'test', medida_pneu: '100/90-18', posicao_pneu: 'rear' });
    expect(client.calls[0]!.text).toContain('OR tire_position'); // filtro de posicao presente
  });

  it('verificarEstoque soma locais e retorna indisponivel quando total zero', async () => {
    const client = clientWithRows([
      [
        {
          product_id: 'p1',
          product_code: 'PIR-175',
          product_name: 'Pirelli MT60',
          location: 'main',
          quantity_available: 0,
          quantity_reserved: 1,
        },
        {
          product_id: 'p1',
          product_code: 'PIR-175',
          product_name: 'Pirelli MT60',
          location: 'dep',
          quantity_available: 2,
          quantity_reserved: 0,
        },
      ],
    ]);

    const result = await verificarEstoque(client, {
      environment: 'test',
      product_code: 'PIR-175',
    });

    expect(result).toMatchObject({
      product_id: 'p1',
      disponivel: true,
      quantidade_total: 2,
    });
    expect(result?.locations).toHaveLength(2);
  });

  it('verificarEstoque exige product_id ou product_code', async () => {
    const client = clientWithRows([]);
    await expect(verificarEstoque(client, { environment: 'test' })).rejects.toThrow(
      'verificarEstoque exige product_id ou product_code',
    );
  });

  it('buscarCompatibilidade resolve veiculo e chama helper SQL de pneus compativeis', async () => {
    const client = clientWithRows([
      [
        {
          id: 'v1',
          make: 'Honda',
          model: 'Bros',
          variant: null,
          year_start: 2015,
          year_end: 2024,
          displacement_cc: 160,
        },
      ],
      [
        {
          product_id: 'p1',
          product_name: 'Pirelli MT60',
          brand: 'Pirelli',
          tire_size: '100/90-17',
          position: 'rear',
          is_oem: true,
          source: 'manual',
          confidence_level: '0.95',
          current_price: '175.00',
          total_stock: 3,
        },
      ],
    ]);

    const result = await buscarCompatibilidade(client, {
      environment: 'test',
      moto_modelo: 'Bros',
      moto_ano: 2020,
      posicao_pneu: 'rear',
    });

    expect(result[0]).toMatchObject({
      vehicle_model_id: 'v1',
      model: 'Bros',
      produtos: [expect.objectContaining({ product_id: 'p1', is_oem: true })],
    });
    expect(client.calls[1]!.text).toContain('commerce.find_compatible_tires');
  });

  it('calcularFrete retorna bairro nao encontrado sem consultar zona', async () => {
    const client = clientWithRows([[]]);

    const result = await calcularFrete(client, {
      environment: 'test',
      bairro: 'Bairro Inexistente',
    });

    expect(result).toMatchObject({
      encontrado: false,
      disponivel: false,
      motivo: 'bairro_nao_encontrado',
    });
    expect(client.calls).toHaveLength(1);
  });

  it('calcularFrete resolve bairro e zona de entrega', async () => {
    const client = clientWithRows([
      [
        {
          geo_resolution_id: 'g1',
          neighborhood_canonical: 'Meier',
          city_name: 'Rio de Janeiro',
          match_type: 'exact',
          similarity: '1',
        },
      ],
      [
        {
          delivery_fee: '0.00',
          delivery_days: 1,
          is_available: true,
          delivery_mode: 'own_fleet',
        },
      ],
    ]);

    const result = await calcularFrete(client, {
      environment: 'test',
      bairro: 'Meier',
      municipio: 'Rio de Janeiro',
    });

    expect(result).toMatchObject({
      encontrado: true,
      disponivel: true,
      valor: '0.00',
      prazo_dias: 1,
    });
  });

  it('buscarPoliticaComercial retorna politicas ativas filtradas por chave', async () => {
    const client = clientWithRows([
      [
        {
          policy_key: 'desconto_maximo',
          policy_value: { pct: 5 },
          description: 'Limite de desconto',
          policy_version: 'v1',
        },
      ],
    ]);

    const result = await buscarPoliticaComercial(client, {
      environment: 'test',
      policy_keys: ['desconto_maximo'],
    });

    expect(result).toEqual([
      {
        policy_key: 'desconto_maximo',
        policy_value: { pct: 5 },
        description: 'Limite de desconto',
        policy_version: 'v1',
      },
    ]);
    expect(client.calls[0]!.text).toContain('commerce.store_policies');
    expect(client.calls[0]!.values).toEqual(['test', ['desconto_maximo']]);
  });

  it('buscarPoliticaComercial ignora policy_key desconhecida sem abortar conhecidas', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const client = clientWithRows([
      [
        {
          policy_key: 'desconto_maximo',
          policy_value: { pct: 5 },
          description: 'Limite de desconto',
          policy_version: 'v1',
        },
        {
          policy_key: 'valor_minimo_pedido',
          policy_value: { min_brl: 50 },
          description: 'Nova politica ainda sem schema',
          policy_version: 'v1',
        },
      ],
    ]);

    const result = await buscarPoliticaComercial(client, { environment: 'test' });

    expect(result).toEqual([
      {
        policy_key: 'desconto_maximo',
        policy_value: { pct: 5 },
        description: 'Limite de desconto',
        policy_version: 'v1',
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      { policy_key: 'valor_minimo_pedido' },
      'atendente_unsupported_policy_key',
    );
    warn.mockRestore();
  });
});
