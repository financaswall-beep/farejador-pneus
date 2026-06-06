import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { LOCATION_MARKER, loadHistory } from '../../../src/atendente-v2/history.js';

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

const at = (iso: string) => new Date(iso);

describe('loadHistory — flag GEO OFF (comportamento de hoje)', () => {
  it('NÃO consulta localização e não injeta marcador', async () => {
    const client = clientWithRows([
      [{ id: 'm1', sender_type: 'contact', content: 'oi', sent_at: at('2026-06-06T10:00:00Z') }],
      [], // turns
    ]);
    const history = await loadHistory(client, 'conv1');
    expect(client.calls).toHaveLength(2); // só messages + turns
    expect(history).toEqual([{ role: 'user', content: 'oi' }]);
  });
});

describe('loadHistory — flag GEO ON (awareness do pino)', () => {
  it('injeta o marcador como turn do cliente, na ordem cronológica certa', async () => {
    const client = clientWithRows([
      [{ id: 'm1', sender_type: 'contact', content: 'quero pneu 140/70-17', sent_at: at('2026-06-06T10:00:00Z') }],
      [], // turns
      [{ id: 'loc1', sent_at: at('2026-06-06T10:01:00Z') }], // pino veio depois do texto
    ]);
    const history = await loadHistory(client, 'conv1', { includeLocationMarkers: true });
    expect(client.calls).toHaveLength(3);
    expect(history).toEqual([
      { role: 'user', content: 'quero pneu 140/70-17' },
      { role: 'user', content: LOCATION_MARKER },
    ]);
  });

  it('pino com legenda (mesmo id já no histórico) NÃO duplica', async () => {
    const client = clientWithRows([
      [{ id: 'loc1', sender_type: 'contact', content: 'segue minha localização', sent_at: at('2026-06-06T10:00:00Z') }],
      [],
      [{ id: 'loc1', sent_at: at('2026-06-06T10:00:00Z') }],
    ]);
    const history = await loadHistory(client, 'conv1', { includeLocationMarkers: true });
    expect(history).toEqual([{ role: 'user', content: 'segue minha localização' }]);
  });

  it('sem pino na conversa → só o texto, sem marcador', async () => {
    const client = clientWithRows([
      [{ id: 'm1', sender_type: 'contact', content: 'bom dia', sent_at: at('2026-06-06T10:00:00Z') }],
      [],
      [], // nenhuma localização
    ]);
    const history = await loadHistory(client, 'conv1', { includeLocationMarkers: true });
    expect(history).toEqual([{ role: 'user', content: 'bom dia' }]);
  });
});
