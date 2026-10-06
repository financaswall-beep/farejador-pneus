import { describe, expect, it, vi } from 'vitest';
import { partnerScreen } from './helpers/partner-simple-dom.js';

const loja = {
  display_name: 'Borracharia Meier', opening_hours_text: '8h às 18h', faz_entrega: true, tem_retirada: true, delivery_radius_km: 5,
  address_street: 'Rua A', address_number: '32', address_neighborhood: 'Méier', address_city: 'Rio de Janeiro',
  address_complement: 'Loja B', cep: '20720-010', maps_url: 'https://example.com/mapa',
};
function setup() {
  const screen = partnerScreen();
  screen.C.partnerData.api = vi.fn(async (resource: string) => resource === 'configuracoes' ? { loja: { ...loja } } : { rows: [] });
  screen.C.partnerHome.sync('partner-profile');
  return screen;
}
async function loaded() { const screen = setup(); await screen.C.partnerStore.load(true); return screen; }
function submit(screen: ReturnType<typeof setup>) {
  const form: any = screen.root.querySelectorAll('form')[0]; form.reportValidity = () => true; return form.fire('submit');
}
const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

describe('Minha loja do parceiro', () => {
  it('mostra ajustes reais, funcionários e som, sem uma aba do rodapé selecionada', async () => {
    const screen = await loaded();
    expect(screen.root.textContent).toContain('8h às 18h');
    expect(screen.root.textContent).toContain('Funcionários');
    expect(screen.root.textContent).toContain('Entrega até 5 km');
    expect(screen.button('Som dos avisos').attributes['role']).toBe('switch');
    expect(screen.node('partner-home-orders').attributes['aria-current']).toBeUndefined();
  });
  it('não consulta nem oferece ajustes administrativos ao funcionário', async () => {
    const screen = partnerScreen(); screen.storage.set('role', 'funcionario');
    screen.C.partnerData.api = vi.fn(); screen.C.partnerHome.sync('partner-profile'); await settle();
    expect(screen.C.partnerData.api).not.toHaveBeenCalled();
    expect(screen.root.textContent).toContain('Funcionário da loja');
    expect(screen.root.textContent).not.toContain('Gerencie sua equipe');
    expect(screen.button('SAIR DA CONTA')).toBeDefined();
  });
  it('preserva nome e todo o endereço atual ao salvar somente o horário', async () => {
    const screen = await loaded(); screen.C.partnerStoreForm.hours();
    screen.root.querySelectorAll('input')[0].value = 'Segunda a sexta, 9h às 17h';
    const fresh = { ...loja, address_street: 'Rua alterada em outra sessão', address_number: '99' };
    screen.C.partnerData.api.mockImplementation(async (resource: string) => resource === 'configuracoes' ? { loja: fresh } : { updated: true });
    await submit(screen); await settle();
    const call = screen.C.partnerData.api.mock.calls.find(([resource]: any[]) => resource === 'configuracoes/loja');
    expect(JSON.parse(call[1].body)).toEqual({
      display_name: fresh.display_name, address_street: fresh.address_street, address_number: '99',
      address_neighborhood: fresh.address_neighborhood, address_city: fresh.address_city,
      address_complement: fresh.address_complement, cep: fresh.cep, maps_url: fresh.maps_url,
      opening_hours_text: 'Segunda a sexta, 9h às 17h',
    });
  });
  it('não faz PUT em outra sessão se o logout ocorrer durante a leitura do cadastro', async () => {
    const screen = await loaded(); screen.C.partnerStoreForm.hours();
    let resolve: (value: any) => void = () => {};
    screen.C.partnerData.api.mockImplementation(() => new Promise(value => { resolve = value; }));
    await submit(screen); screen.setSession('session-b'); screen.C.partnerStore.leave();
    resolve({ loja }); await settle();
    expect(screen.C.partnerData.api.mock.calls.filter(([resource]: any[]) => resource === 'configuracoes/loja')).toHaveLength(0);
    expect(screen.C.showToast).not.toHaveBeenCalled();
  });
  it('mantém formulário e dados digitados durante atualização de avisos', async () => {
    const screen = await loaded(); screen.C.partnerStoreForm.hours();
    const page = screen.root.children[0]; const input = screen.root.querySelectorAll('input')[0]; input.value = 'Domingo 8h';
    screen.C.partnerHome.render(); expect(screen.root.children[0]).toBe(page); expect(input.value).toBe('Domingo 8h');
  });
  it('valida retirada e entrega e zera o raio quando a loja deixa de entregar', async () => {
    const screen = await loaded(); screen.C.partnerStoreForm.service();
    const inputs: any[] = screen.root.querySelectorAll('input'); inputs[0].checked = false; inputs[1].checked = false;
    await submit(screen); await settle();
    expect(screen.root.textContent).toContain('Escolha retirada');
    expect(screen.C.partnerData.api.mock.calls.some(([resource]: any[]) => resource === 'configuracoes/atendimento')).toBe(false);
    inputs[0].checked = true; await submit(screen); await settle();
    const call = screen.C.partnerData.api.mock.calls.find(([resource]: any[]) => resource === 'configuracoes/atendimento');
    expect(JSON.parse(call[1].body)).toEqual({ faz_entrega: false, tem_retirada: true, delivery_radius_km: null });
  });
  it('mostra erro com tentativa e não usa dados fictícios como configuração real', async () => {
    const screen = setup(); screen.C.partnerData.api.mockRejectedValue(new Error('offline'));
    await settle(); await screen.C.partnerStore.load(true);
    expect(screen.root.textContent).toContain('Não consegui carregar');
    expect(screen.button('TENTAR DE NOVO')).toBeDefined();
  });
  it('impede que uma lista atrasada de funcionários reabra após voltar', async () => {
    const screen = await loaded(); let resolve: (value: any) => void = () => {};
    screen.C.partnerData.api.mockImplementation(() => new Promise(value => { resolve = value; }));
    const pending = screen.C.partnerTeam.open(); screen.C.partnerStore.back(); resolve({ rows: [{ id: 'x', label: 'Pedro' }] }); await pending;
    expect(screen.root.textContent).toContain('Minha loja'); expect(screen.root.textContent).not.toContain('Pedro');
  });
  it('envia todas as permissões reais, inclusive as desmarcadas', async () => {
    const screen = await loaded();
    screen.C.partnerData.api.mockImplementation(async (resource: string) => resource === 'funcionarios' ? { rows: [{ id: 'x', label: 'Pedro', username: 'pedro', revoked_at: null }] }
      : resource.endsWith('/config') ? { permissions: { vendas: true, pedidos: true, clientes: true } } : {});
    await screen.C.partnerTeam.open(); await screen.button('Pedro').click(); await settle();
    const inputs: any[] = screen.root.querySelectorAll('input'); inputs[0].checked = false;
    await submit(screen); await settle();
    const call = screen.C.partnerData.api.mock.calls.find(([resource]: any[]) => resource === 'funcionarios/x/permissoes');
    const payload = JSON.parse(call[1].body);
    expect(Object.keys(payload)).toHaveLength(12); expect(payload.vendas).toBe(false); expect(payload.pedidos).toBe(true); expect(payload.clientes).toBe(true);
  });
  it('não entra na tela simples nem consulta suas APIs na matriz', async () => {
    const screen = partnerScreen(false); screen.C.partnerData.api = vi.fn(); screen.C.partnerStore.render(); await screen.C.partnerStore.load();
    expect(screen.C.partnerData.api).not.toHaveBeenCalled(); expect(screen.root.textContent).toBe('');
  });
});
