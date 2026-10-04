import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

class Element {
  textContent = '';
  disabled = false;
  title = '';
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  events: Record<string, () => void> = {};
  classes = new Set<string>();
  style = { removeProperty: vi.fn() };
  click = vi.fn(() => this.events.click?.());
  classList = {
    toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name),
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
  };
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(name: string, handler: () => void) { this.events[name] = handler; }
}

function screen(partner = true, allowed = { vendas: true, estoque: true }) {
  const nodes: Record<string, Element> = {};
  const node = (id: string) => nodes[id] ??= new Element();
  const storage = new Map<string, string>([['role', 'owner'], ['modules', JSON.stringify(allowed)]]);
  const location = { hash: '', pathname: '/operacao', search: '' };
  const C: any = {
    keys: { role: 'role', modules: 'modules', token: 'token', store: 'store', name: 'name' },
    isPartner: () => partner, scope: () => partner ? 'partner' : 'matrix',
    stored: (key: string) => storage.get(key) || '', token: () => 'fake-session',
    elements: { app: node('app') }, state: { photoRequests: [], systemNotifications: [] },
    showTab: vi.fn(), openNotifications: vi.fn(), openPhotoRequest: vi.fn(),
    startPhotoNotifications: vi.fn(), loadSystemNotifications: vi.fn(),
  };
  const context = {
    window: { Caixa: C, location }, location,
    history: { replaceState: vi.fn() },
    document: { getElementById: node, querySelector: () => node('legacy-nav') },
    sessionStorage: { getItem: () => '' }, localStorage: { setItem: vi.fn() },
  };
  for (const file of ['caixa-modules.js', 'caixa-partner-home.js']) {
    runInNewContext(readFileSync('painel/public/' + file, 'utf8'), context);
  }
  return { C, nodes, node, location };
}

describe('início simples do parceiro, preservando a Operação da matriz', () => {
  it('abre a matriz no Caixa e impede o modo parceiro mesmo com a URL de Pedidos', () => {
    const { C, location, node } = screen(false);
    expect(C.initialOperationTab()).toBe('cash');
    location.hash = '#pedidos';
    expect(C.initialOperationTab()).toBe('cash');
    expect(C.authorizedOperationTab('partner-home')).toBe('cash');
    C.applyModuleNavigation(); C.partnerHome.sync('partner-home');
    expect(node('nav-partner-home').classes.has('hidden')).toBe(true);
    expect(node('app').classes.has('is-partner-home')).toBe(false);
    expect(node('partner-home-panel').classes.has('hidden')).toBe(true);
  });

  it('abre o parceiro em Pedidos e preserva links autorizados das telas existentes', () => {
    const { C, location, node } = screen();
    expect(C.initialOperationTab()).toBe('partner-home');
    C.applyModuleNavigation();
    expect(node('nav-partner-home').classes.has('hidden')).toBe(false);
    location.hash = '#catalogo';
    expect(C.initialOperationTab()).toBe('catalog');
    expect(C.authorizedOperationTab('finance')).toBe('cash');
  });

  it('não anuncia tudo em dia enquanto os avisos ainda não foram consultados', () => {
    const { C, node } = screen();
    C.partnerHome.sync('partner-home');
    expect(node('partner-home-title').textContent).toBe('Conferindo pedidos…');
    C.state.systemNotificationLoadState = 'ready'; C.partnerHome.render();
    expect(node('partner-home-panel').dataset.status).toBe('loading');
    C.state.photoLoadState = 'ready'; C.partnerHome.render();
    expect(node('partner-home-title').textContent).toBe('Tudo em dia!');
    expect(node('partner-home-badge').classes.has('hidden')).toBe(true);
    expect(node('partner-home-panel').attributes['aria-busy']).toBe('false');
  });

  it('apresenta falha com nova tentativa em vez de declarar que não há pedido', () => {
    const { C, node } = screen();
    C.state.photoLoadState = 'error'; C.state.systemNotificationLoadState = 'ready';
    C.partnerHome.sync('partner-home');
    expect(node('partner-home-title').textContent).toBe('Não consegui atualizar');
    expect(node('partner-home-action').classes.has('hidden')).toBe(false);
    node('partner-home-action').click();
    expect(C.startPhotoNotifications).toHaveBeenCalledOnce();
    expect(C.loadSystemNotifications).toHaveBeenCalledOnce();
    expect(node('partner-home-panel').dataset.status).toBe('loading');
  });

  it('prioriza cliente aguardando foto e abre a solicitação real sem expor nome', () => {
    const { C, node } = screen();
    C.state.photoRequests = [{ id: 'photo-1', customer_name: 'Nome sensível' }];
    C.partnerHome.sync('partner-home');
    expect(node('partner-home-title').textContent).toBe('Cliente esperando');
    expect(node('partner-home-copy').textContent).not.toContain('Nome sensível');
    expect(node('partner-home-badge').textContent).toBe('1');
    node('partner-home-action').click();
    expect(C.openPhotoRequest).toHaveBeenCalledWith('photo-1');
  });

  it('mostra os avisos reais e usa os controles existentes para vendas, estoque e perfil', () => {
    const { C, node } = screen();
    C.state.photoLoadState = 'ready'; C.state.systemNotificationLoadState = 'ready';
    C.state.systemNotifications = [{ id: 'stock-low' }];
    C.partnerHome.start({ store_name: 'Borracharia Meier', display_name: 'João' });
    C.partnerHome.sync('partner-home');
    expect(node('partner-home-store').textContent).toBe('Borracharia Meier');
    expect(node('partner-home-profile').attributes['aria-label']).toBe('Minha loja — João');
    expect(node('partner-home-title').textContent).toBe('Você tem avisos');
    node('partner-home-notifications').click();
    expect(C.openNotifications).toHaveBeenCalledWith('system');
    node('partner-home-sales').click(); node('partner-home-stock').click(); node('partner-home-profile').click();
    expect(node('nav-sales').click).toHaveBeenCalledOnce();
    expect(node('nav-stock').click).toHaveBeenCalledOnce();
    expect(node('operator-button').click).toHaveBeenCalledOnce();
    C.partnerHome.reset();
    expect(node('app').classes.has('is-partner-home')).toBe(false);
    expect(node('partner-home-store').textContent).toBe('Minha loja');
  });

  it('respeita as permissões de estoque e vendas e não aguarda fotos sem vendas', () => {
    const { C, node } = screen(true, { vendas: false, estoque: false });
    C.state.systemNotificationLoadState = 'ready';
    C.partnerHome.start({}); C.partnerHome.sync('partner-home');
    expect(node('partner-home-stock').disabled).toBe(true);
    expect(node('partner-home-sales').disabled).toBe(true);
    node('partner-home-sales').click(); node('partner-home-stock').click();
    expect(node('nav-sales').click).not.toHaveBeenCalled();
    expect(node('nav-stock').click).not.toHaveBeenCalled();
    expect(node('partner-home-title').textContent).toBe('Tudo em dia!');
  });
});
