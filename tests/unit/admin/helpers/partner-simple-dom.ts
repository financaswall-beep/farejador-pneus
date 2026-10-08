import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { vi } from 'vitest';

export class TestNode {
  tagName: string;
  children: TestNode[] = [];
  ownText = '';
  className = '';
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  handlers: Record<string, Array<(...args: any[]) => unknown>> = {};
  disabled = false;
  hidden = false;
  title = '';
  value = '';
  files: unknown[] = [];
  open = false;
  focus = vi.fn();
  parentElement: TestNode | null = null;
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  replaceWith(node: TestNode) {
    if (!this.parentElement) return;
    node.parentElement = this.parentElement;
    this.parentElement.children[this.parentElement.children.indexOf(this)] = node;
  }
  after(node: TestNode) {
    if (!this.parentElement) return;
    node.parentElement = this.parentElement;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this) + 1, 0, node);
  }
  showModal() { this.open = true; }
  close() { this.open = false; void this.fire('close'); }
  style: Record<string, any> = {
    setProperty: vi.fn((name: string, value: string) => { this.style[name] = value; }),
    removeProperty: vi.fn((name: string) => { delete this.style[name]; }),
  };
  constructor(tagName = 'div') { this.tagName = tagName; }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.ownText = String(value); this.children = []; }
  append(...nodes: TestNode[]) { nodes.forEach(node => { node.parentElement = this; }); this.children.push(...nodes); }
  prepend(...nodes: TestNode[]) { nodes.forEach(node => { node.parentElement = this; }); this.children.unshift(...nodes); }
  appendChild(node: TestNode) { node.parentElement = this; this.children.push(node); return node; }
  replaceChildren(...nodes: TestNode[]) { this.ownText = ''; this.children = []; this.append(...nodes); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  addEventListener(name: string, handler: (...args: any[]) => unknown) { (this.handlers[name] ||= []).push(handler); }
  click() { if (!this.disabled) return this.fire('click'); }
  fire(name: string) { return Promise.all((this.handlers[name] || []).map(handler => handler({ target: this, preventDefault: () => {} }))); }
  querySelectorAll(selector: string): TestNode[] {
    const tags = selector.split(',');
    return this.children.flatMap(child => [...(tags.some(tag => tag.startsWith('.') ? child.classList.contains(tag.slice(1)) : tag === child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string): TestNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  classList = {
    add: (...names: string[]) => { this.className = [...new Set(this.className.split(' ').concat(names))].join(' ').trim(); },
    remove: (...names: string[]) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
    contains: (name: string) => this.className.split(' ').includes(name),
    toggle: (name: string, enabled?: boolean) => {
      const active = enabled ?? !this.classList.contains(name);
      if (active) this.classList.add(name); else this.classList.remove(name);
      return active;
    },
  };
}

export function partnerScreen(partner = true, permissions: Record<string, boolean> = { vendas: true, estoque: true, retiradas: true, entregas: true }) {
  const nodes: Record<string, TestNode> = {};
  const node = (id: string) => nodes[id] ||= new TestNode();
  const storage = new Map([['role', 'owner'], ['modules', JSON.stringify(permissions)], ['name', 'João'], ['store', 'Borracharia Meier']]);
  let session = 'session-a';
  const location = { hash: '#pedidos', pathname: '/operacao', search: '' };
  const C: any = {
    keys: { role: 'role', modules: 'modules', name: 'name', store: 'store', notifications: 'notifications' },
    stored: (key: string) => storage.get(key) || '', token: () => session,
    isPartner: () => partner, scope: () => partner ? 'partner' : 'matrix',
    operationPath: (resource: string) => '/parceiro/meier/api/' + resource,
    sessionFingerprint: () => session,
    authenticatedFetch: vi.fn(async () => ({ ok: true, json: async () => ({ rows: [] }) })),
    json: (response: any) => response.json(), currency: new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }),
    createSvg: () => new TestNode('svg'), showToast: vi.fn(), checkoutRuntime: { close: vi.fn() },
    elements: { app: node('app'), notificationsToggle: node('sound'), logout: node('logout') },
    state: { photoRequests: [], photoLoadState: 'ready', systemNotifications: [] },
    compressPhoto: vi.fn(async () => ({ type: 'image/jpeg' })),
    photoUploadPath: (id: string) => '/parceiro/meier/api/operacao/pedidos-foto/' + id + '/foto',
    loadPhotoRequests: vi.fn(async () => {}),
    partnerSales: { render: vi.fn(), load: vi.fn(async () => {}), leave: vi.fn() },
  };
  const context = {
    window: { Caixa: C, location, navigator: { onLine: true }, addEventListener: vi.fn(), removeEventListener: vi.fn(), scrollTo: vi.fn(),
      setInterval: vi.fn(() => 1), clearInterval: vi.fn() }, location,
    history: { replaceState: (_: any, __: any, path: string) => { location.hash = path.includes('#') ? '#' + path.split('#')[1] : ''; } },
    document: { documentElement: new TestNode('html'), getElementById: node, createElement: (tag: string) => new TestNode(tag), createTextNode: (text: string) => { const el = new TestNode('#text'); el.textContent = text; return el; },
      querySelector: () => node('legacy-nav') },
    localStorage: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) },
    sessionStorage: { getItem: () => '' }, AbortController, Promise, Date,
    URL: { createObjectURL: vi.fn(() => 'blob:photo'), revokeObjectURL: vi.fn() },
  };
  for (const file of ['modules', 'brand-catalog', 'partner-ui', 'partner-data', 'partner-orders', 'partner-waiting', 'partner-photo', 'partner-pickups', 'partner-deliveries', 'partner-stock-fields', 'partner-stock-form', 'partner-stock', 'partner-store', 'partner-store-form', 'partner-team', 'partner-extras', 'partner-buy-ui', 'partner-buy-orders', 'partner-buy', 'partner-replenishment', 'partner-home']) {
    if (file === 'partner-photo') {
      runInNewContext(readFileSync('painel/public/caixa-partner-photo-ui.js', 'utf8'), context);
      runInNewContext(readFileSync('painel/public/caixa-partner-photo-upload.js', 'utf8'), context);
    }
    runInNewContext(readFileSync('painel/public/caixa-' + file + '.js', 'utf8'), context);
  }
  C.showTab = (tab: string) => C.partnerHome.sync(C.authorizedOperationTab(tab));
  const root = node('partner-home-screen');
  return { C, node, root, location, context, storage,
    setSession: (value: string) => { session = value; },
    button: (label: string) => root.querySelectorAll('button').find(button => button.attributes['aria-label'] === label || button.textContent === label)!,
    ready: () => { C.partnerData.state.ready = true; C.partnerHome.sync('partner-home'); },
  };
}
