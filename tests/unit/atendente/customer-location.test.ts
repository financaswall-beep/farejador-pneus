import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { getLatestCustomerLocation } from '../../../src/atendente-v2/customer-location.js';

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

describe('getLatestCustomerLocation', () => {
  it('sem anexo de localização → null', async () => {
    const client = clientWithRows([[]]);
    expect(await getLatestCustomerLocation(client, 'test', 'conv1')).toBeNull();
  });

  it('lê o pino mais recente; NUMERIC (string do pg) vira number', async () => {
    const client = clientWithRows([[{ coordinates_lat: '-22.984613', coordinates_lng: '-43.198278' }]]);
    expect(await getLatestCustomerLocation(client, 'test', 'conv1')).toEqual({
      lat: -22.984613,
      lng: -43.198278,
    });
  });

  it('escopo certo: file_type=location, environment+conversa, mais recente primeiro', async () => {
    const client = clientWithRows([[{ coordinates_lat: -22.9, coordinates_lng: -43.1 }]]);
    await getLatestCustomerLocation(client, 'prod', 'conv-xyz');
    const call = client.calls[0]!;
    expect(call.text).toContain("file_type = 'location'");
    expect(call.text).toContain('environment = $1');
    expect(call.text).toContain('conversation_id = $2');
    expect(call.text).toContain('ORDER BY created_at DESC');
    expect(call.text).toContain('LIMIT 1');
    expect(call.values).toEqual(['prod', 'conv-xyz']);
  });

  it('coordenada não-numérica → null (defensivo)', async () => {
    const client = clientWithRows([[{ coordinates_lat: 'abc', coordinates_lng: '-43.1' }]]);
    expect(await getLatestCustomerLocation(client, 'test', 'conv1')).toBeNull();
  });
});
