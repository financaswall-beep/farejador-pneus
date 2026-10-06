import { describe, expect, it } from 'vitest';
import { partnerScreen } from './helpers/partner-simple-dom.js';

const payload = {
  replenishment: { measure: '90/90-18', demand_count: 3, quantity_available: 8, period_days: 7 },
  rows: [{ measure: '90/90-18', brand: 'Pirelli', tire_condition: 'meia_vida', quantity_available: 8 }],
};
function responses(C: any, restock: unknown = payload) {
  C.authenticatedFetch.mockImplementation(async (path: string) => ({
    ok: true, json: async () => path.endsWith('/reposicao') ? restock : { rows: [] },
  }));
}

describe('Oportunidade de reposição do parceiro', () => {
  it('carrega sem permissão de entrega e abre somente os pneus da oportunidade', async () => {
    const { C, root, ready, button, location } = partnerScreen(true, { estoque: true });
    ready(); responses(C); await C.partnerData.load();
    expect(root.textContent).toContain('Te pediram e você não tinha');
    expect(root.textContent).toContain('1 medida para repor');
    expect(root.textContent).not.toContain('Exemplo');
    await button('REPOR PNEUS').click();
    expect(location.hash).toBe('#reposicao');
    expect(root.textContent).toContain('90/90-18');
    expect(root.textContent).toContain('3 clientes pediram');
    expect(root.textContent).toContain('Meia-vidaPirelli8 disponíveis');
    expect(root.textContent).not.toContain('Faturamento');
    await button('Voltar').click(); expect(location.hash).toBe('#pedidos');
  });
  it('remove o cartão quando a oportunidade acaba e descarta saldo antigo se a consulta falhar', async () => {
    const { C, root, ready } = partnerScreen(); ready(); responses(C); await C.partnerData.load();
    responses(C, { replenishment: null, rows: [] }); await C.partnerData.load();
    expect(root.textContent).not.toContain('Te pediram');
    expect(C.partnerData.state.offers).toEqual([]);
    responses(C); await C.partnerData.load();
    C.authenticatedFetch.mockImplementation(async (path: string) => {
      if (path.endsWith('/reposicao')) throw Error('offline');
      return { ok: true, json: async () => ({ rows: [] }) };
    });
    await C.partnerData.load();
    expect(C.partnerData.state.replenishment).toBeNull();
    expect(root.textContent).not.toContain('REPOR PNEUS');
    C.partnerHome.open('partner-replenishment'); expect(root.textContent).toContain('Não consegui atualizar a 2W');
  });
  it('conta medidas, sem somar clientes nem variantes, e abre todas as oportunidades', async () => {
    const { C, root, ready, button } = partnerScreen(); ready();
    const measures = [
      { measure: '100/90-18', demand_count: 4, quantity_available: 10 },
      { measure: '90/90-18', demand_count: 3, quantity_available: 12 },
      { measure: '80/100-14', demand_count: 2, quantity_available: 8 },
      { measure: '110/90-17', demand_count: 8, quantity_available: 0 },
    ];
    responses(C, { replenishment: { ...measures[0], measures }, rows: measures.map(row => ({ ...row, brand: 'Pirelli', tire_condition: 'meia_vida' })) });
    await C.partnerData.load(); expect(root.textContent).toContain('3 medidas para repor');
    expect(root.textContent).not.toContain('9 medidas');
    await button('REPOR PNEUS').click();
    for (const row of measures.slice(0, 3)) expect(root.textContent).toContain(row.measure);
    expect(root.textContent).not.toContain('110/90-17');
  });
  it('respeita a permissão de estoque, o ambiente matriz e o fim da sessão', async () => {
    const denied = partnerScreen(true, { vendas: true }); denied.ready(); responses(denied.C);
    await denied.C.partnerData.load();
    expect(denied.C.authenticatedFetch.mock.calls.some(([path]: [string]) => path.endsWith('/reposicao'))).toBe(false);
    expect(denied.C.authorizedOperationTab('partner-replenishment')).toBe('partner-home');
    const matrix = partnerScreen(false); await matrix.C.partnerData.load();
    expect(matrix.C.authenticatedFetch).not.toHaveBeenCalled();
    const own = partnerScreen(); own.ready(); responses(own.C); await own.C.partnerData.load();
    own.C.partnerHome.reset(); expect(own.C.partnerData.state.offers).toEqual([]);
    expect(own.C.partnerData.state.replenishment).toBeNull();
  });
  it('um resultado da sessão anterior não preenche a nova loja', async () => {
    const { C, ready, setSession } = partnerScreen(); ready();
    let done: (value: unknown) => void = () => {};
    C.authenticatedFetch.mockImplementation(async (path: string) => path.endsWith('/reposicao')
      ? new Promise(resolve => { done = resolve; }) : { ok: true, json: async () => ({ rows: [] }) });
    const loading = C.partnerData.load(); setSession('session-b');
    C.partnerData.reset(); done({ ok: true, json: async () => payload }); await loading;
    expect(C.partnerData.state.replenishment).toBeNull();
  });
});
