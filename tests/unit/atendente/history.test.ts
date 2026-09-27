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

describe('fotos enviadas pelo funcionário', () => {
  it.each(['', 'Ó ele aqui 📸'])('preserva a imagem com legenda "%s"', async caption => {
    const client = clientWithRows([[{ id: 'photo', sender_type: 'user', content: caption, has_image: true,
      status: 'sent', sent_at: at('2026-09-27T16:25:27Z') }], []]);
    const history = await loadHistory(client, 'conv');
    expect(history).toHaveLength(1);
    expect(history[0]?.role).toBe('assistant');
    expect(history[0]?.content).toContain('A loja enviou uma imagem');
    if (caption) expect(history[0]?.content).toContain(caption);
  });
  it('diferencia foto do cliente e envio com falha', async () => {
    const client = clientWithRows([[
      { id: 'failed', sender_type: 'user', content: '', has_image: true, status: 'failed', sent_at: at('2026-09-27T16:26:00Z') },
      { id: 'incoming', sender_type: 'contact', content: '', has_image: true, sent_at: at('2026-09-27T16:25:27Z') },
    ], []]);
    expect(await loadHistory(client, 'conv')).toEqual([
      { role: 'user', content: '[O cliente enviou uma imagem.]' },
      { role: 'assistant', content: '[O envio de uma imagem pela loja falhou. Não confirme o envio.]' },
    ]);
  });
});

it('mantém a oferta antes da localização e inclui áudio sem alterar a mensagem original',async()=>{
  const client=clientWithRows([
    [{id:'m1',sender_type:'contact',content:'Sou de Caxias',sent_at:at('2026-09-27T12:01:00Z')}],[],
    [{id:'out',sender_type:'user',content:'Temos 90/90-12. De onde você está falando, meu amigo?',sent_at:at('2026-09-27T12:00:00Z')}],
    [{id:'m2',content:'[Áudio transcrito; confiança medium] Quero dois.',sent_at:at('2026-09-27T12:02:00Z')}],
  ]);
  expect(await loadHistory(client,'conv',{includeOrganic:true,includeAudio:true})).toEqual([
    {role:'assistant',content:'Temos 90/90-12. De onde você está falando, meu amigo?'},
    {role:'user',content:'Sou de Caxias'},{role:'user',content:'[Áudio transcrito; confiança medium] Quero dois.'},
  ]);
  expect(client.calls.every(c=>!c.text.includes('UPDATE'))).toBe(true);
});

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
