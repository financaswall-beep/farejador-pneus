import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { requestPhotoBatch } from '../../../src/atendente-v2/photo-batch.js';
import { photoRequestNudge } from '../../../src/atendente-v2/photo-nudge.js';
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const client = () => ({ query: vi.fn(async () => ({ rows: [{ id: a }, { id: b }] })) });
describe('pedido de fotos dos dois pneus', () => {
  it('executa uma vez por UUID e conserva localização e os resultados individuais', async () => {
    const db = client(), request = vi.fn(async (args: any) => JSON.stringify({ status: 'foto_solicitada', prazo_min: 10, product_id: args.product_id }));
    const result = JSON.parse(await requestPhotoBatch(db as unknown as PoolClient, 'test', { product_ids: [a, b], bairro: 'Méier' }, request));
    expect(result.status).toBe('fotos_solicitadas'); expect(result.total_solicitado).toBe(2);
    expect(result.solicitacoes.map((r: any) => r.product_id)).toEqual([a, b]);
    expect(request.mock.calls.map(([args]) => args)).toEqual([{ product_id: a, bairro: 'Méier' }, { product_id: b, bairro: 'Méier' }]);
    expect(db.query.mock.calls[0]).toEqual([expect.stringContaining('environment=$1'), ['test', [a, b]]]);
  });
  it.each([[], [a, b, a], ['inválido', b], null])('rejeita conjunto inválido antes de consultar ou criar cards (%j)', async ids => {
    const db = client(), request = vi.fn();
    const result = JSON.parse(await requestPhotoBatch(db as unknown as PoolClient, 'test', { product_ids: ids }, request));
    expect(result.status).toBe('precisa_produto'); expect(db.query).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
  it('não cria o primeiro card quando o segundo UUID pertence a outro ambiente', async () => {
    const db = client(); db.query.mockResolvedValue({ rows: [{ id: a }] }); const request = vi.fn();
    const result = JSON.parse(await requestPhotoBatch(db as unknown as PoolClient, 'test', { product_ids: [a, b] }, request));
    expect(result.status).toBe('precisa_produto'); expect(request).not.toHaveBeenCalled();
  });
  it('deduplica UUID repetido e não trata resposta parcial como sucesso para ambos', async () => {
    const db = client(); db.query.mockResolvedValueOnce({ rows: [{ id: a }] });
    const request = vi.fn().mockResolvedValueOnce(JSON.stringify({ status: 'foto_solicitada' }));
    const one = JSON.parse(await requestPhotoBatch(db as unknown as PoolClient, 'test', { product_ids: [a, a] }, request));
    expect(one.total_solicitado).toBe(1); expect(request).toHaveBeenCalledTimes(1);
    request.mockReset().mockResolvedValueOnce(JSON.stringify({ status: 'aguardando_parceiro' })).mockResolvedValueOnce(JSON.stringify({ status: 'sem_loja' }));
    const two = JSON.parse(await requestPhotoBatch(db as unknown as PoolClient, 'test', { product_ids: [a, b] }, request));
    expect(two).toMatchObject({ status: 'fotos_parciais', total_solicitado: 1 });
    expect(two.solicitacoes[0].status).toBe('aguardando_parceiro'); expect(two.solicitacoes[1].status).toBe('sem_loja');
  });
  it('reforça o pedido de conjunto somente em turnos de foto, respeitando negações', () => {
    expect(photoRequestNudge('manda foto dos dois pneus')).toContain('product_ids');
    expect(photoRequestNudge('não preciso de foto')).toBe(''); expect(photoRequestNudge('qual o preço?')).toBe('');
    expect(photoRequestNudge('pode mandar', 'Quer as fotos?')).toContain('product_ids');
  });
});
