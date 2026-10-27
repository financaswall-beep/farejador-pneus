import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
function setup() {
  const M: any = { pages: {}, state: { network: 'all', results: { active_platforms: ['instagram', 'facebook'], sources: [{ status: 'ready' }] } },
    V: { number: (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null }, el: () => ({ addEventListener: vi.fn() }) };
  vm.runInNewContext(readFileSync('painel/public/caixa-marketing-results.js', 'utf8'), { window: { Caixa: { marketing: M } }, document: { querySelectorAll: () => [] } }); return M;
}
const d = (platform: string, views: number | null, status = 'published') => ({ platform, views, status });
describe('contadores de resultados no app', () => {
  it('soma apenas os destinos publicados nas redes autorizadas, sem contar falha ou rede inativa', () => {
    const m = setup(), post = { deliveries: [d('instagram', 4120), d('facebook', 2300), d('youtube', 99999), d('instagram', 999, 'failed')] };
    expect(m.resultViews(post)).toEqual({ value: 6420, partial: false });
    expect(m.resultViews(post, 'facebook')).toEqual({ value: 2300, partial: false });
  });
  it('distingue zero observado, métrica indisponível e soma parcial', () => {
    const m = setup();
    expect(m.resultViews({ deliveries: [d('instagram', 0)] })).toEqual({ value: 0, partial: false });
    expect(m.resultViews({ deliveries: [d('instagram', null)] })).toEqual({ value: null, partial: true });
    expect(m.resultViews({ deliveries: [d('instagram', 10), d('facebook', null)] })).toEqual({ value: 10, partial: true });
    expect(m.resultViews({ deliveries: [d('instagram', NaN)] })).toEqual({ value: null, partial: true });
  });
  it('sinaliza fontes truncadas ou indisponíveis e não transforma ausência de coleta em zero', () => {
    const m = setup(), posts = [{ deliveries: [d('instagram', 10)] }, { deliveries: [d('facebook', null)] }];
    expect(m.resultTotal(posts, 'all')).toEqual({ value: 10, partial: true });
    m.state.results.central_truncated = true;
    expect(m.resultTotal([posts[0]], 'all')).toEqual({ value: 10, partial: true });
    m.state.results.sources = [{ status: 'unavailable' }];
    expect(m.resultTotal([], 'all')).toEqual({ value: null, partial: true });
  });
  it('avalia a disponibilidade da rede selecionada sem atribuir a ela a falha de outra rede', () => {
    const m = setup(), posts = [{ deliveries: [d('instagram', 10), d('facebook', 20)] }];
    m.state.results.sources = [{ platform: 'instagram', status: 'ready' }, { platform: 'facebook', status: 'unavailable' }];
    expect(m.resultTotal(posts, 'instagram')).toEqual({ value: 10, partial: false });
    expect(m.resultTotal(posts, 'all')).toEqual({ value: 30, partial: true });
    expect(m.resultTotal([], 'facebook')).toEqual({ value: null, partial: true });
    expect(m.resultTotal([], 'instagram')).toEqual({ value: 0, partial: false });
    expect(m.resultTotal([], 'all')).toEqual({ value: null, partial: true });
    m.state.results.central_available = false;
    expect(m.resultTotal(posts, 'instagram')).toEqual({ value: 10, partial: true });
    expect(m.resultTotal([], 'instagram')).toEqual({ value: null, partial: true });
  });
});
