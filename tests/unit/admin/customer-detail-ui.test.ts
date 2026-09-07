import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function setup() {
  const trigger = { focus:vi.fn(),isConnected:true };
  const closeButton = { focus:vi.fn() };
  const context = createContext({ window:{ PAINEL_MODULES:{} },document:{ activeElement:trigger,getElementById:(id:string) => id === 'cliente-ficha-fechar' ? closeButton : null },
    lucide:{ createIcons:vi.fn() },console,URL,setTimeout,clearTimeout });
  for (const file of ['app.clientes.js','app.clientes.ficha.js']) runInContext(readFileSync('painel/public/'+file,'utf8'),context);
  const ui = runInContext('Object.assign({},window.PAINEL_MODULES.clientes(),window.PAINEL_MODULES.clientesFicha())',context);
  Object.assign(ui,{ $nextTick:(cb:()=>void) => cb(),apiGet:vi.fn(),carregarClienteLeadFoto:vi.fn(),
    currentPage:'clientes',clientesBusca:'Ana',clientesPagina:2,clientesOrigem:'parceiro',
    clienteLeadFoto:vi.fn(() => ''),clienteLeadConversaUrl:vi.fn(() => '') });
  return { ui,closeButton,trigger };
}
const customer = { id:'parceiro:a',source:'parceiro',source_id:'a',name:'Ana' };
const payload = { customer,summary:{ purchases:1 },orders:[{ id:'p1' }],next_offset:10,history_total:11 };
const tick = () => new Promise(resolve => setTimeout(resolve,0));
describe('ficha lateral de Clientes',() => {
  it('histórico abre na lateral, mantém filtros/página e devolve foco ao fechar',async () => {
    const { ui,closeButton,trigger } = setup(); ui.apiGet.mockResolvedValue(payload);
    ui.abrirHistoricoCliente(customer); await tick();
    expect(ui.clienteFichaAberta).toBe(true); expect(closeButton.focus).toHaveBeenCalledTimes(1);
    expect(ui.currentPage).toBe('clientes');
    expect(ui.clientesBusca).toBe('Ana'); expect(ui.clientesPagina).toBe(2); expect(ui.clientesOrigem).toBe('parceiro');
    expect(ui.clienteFicha.customer).toEqual(customer);
    ui.fecharFichaCliente();
    expect(trigger.focus).toHaveBeenCalled(); expect(ui.clienteFichaAberta).toBe(false);
    expect(ui.clienteFicha).toBeNull();
  });
  it('descarta resposta atrasada de outro cliente e de uma ficha fechada',async () => {
    const { ui } = setup(); let first:(value:unknown)=>void = () => undefined;
    ui.apiGet.mockReturnValueOnce(new Promise(resolve => { first=resolve; })).mockResolvedValueOnce({ ...payload,customer:{ ...customer,source_id:'b' } });
    ui.abrirFichaCliente(customer); ui.abrirFichaCliente({ ...customer,source_id:'b' }); await tick();
    first(payload); await tick(); expect(ui.clienteFicha.customer.source_id).toBe('b');
    ui.apiGet.mockReturnValueOnce(new Promise(resolve => { first=resolve; }));
    ui.abrirFichaCliente(customer); ui.fecharFichaCliente(); first(payload); await tick();
    expect(ui.clienteFicha).toBeNull(); expect(ui.clienteFichaAberta).toBe(false);
  });
  it('carrega mais compras na própria lateral sem trocar cliente ou apagar as anteriores',async () => {
    const { ui } = setup(); ui.apiGet.mockResolvedValueOnce(payload).mockResolvedValueOnce({ ...payload,orders:[{ id:'p2' }],next_offset:null });
    ui.abrirFichaCliente(customer); await tick(); await ui.carregarFichaCliente(true);
    expect(ui.clienteFicha.orders.map((o:{id:string}) => o.id)).toEqual(['p1','p2']);
    expect(ui.apiGet).toHaveBeenLastCalledWith('/admin/api/clientes/parceiro/a/ficha?limit=10&offset=10');
    expect(ui.currentPage).toBe('clientes');
  });
  it('mostra erro e permite tentar novamente, sem fingir ausência de compras',async () => {
    const { ui } = setup(); ui.apiGet.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(payload);
    ui.abrirFichaCliente(customer); await tick();
    expect(ui.clienteFichaErro).toContain('Não foi possível'); expect(ui.clienteFicha).toBeNull();
    await ui.carregarFichaCliente(); expect(ui.clienteFichaErro).toBe(''); expect(ui.clienteFicha).not.toBeNull();
  });
  it('preserva o modelo aprovado, escapes de texto e navegação acessível',() => {
    const html = readFileSync('painel/public/index.html','utf8');
    const drawer = html.slice(html.indexOf('<!-- Ficha de leitura:'),html.indexOf('<!-- ═══ TELA: MARKETING'));
    expect(drawer).toContain('bg-emerald-900'); expect(drawer).toContain('text-white');
    expect(drawer).toContain('class="fixed inset-0"'); expect(drawer).toContain('absolute inset-y-0 right-0');
    expect(drawer).toContain('role="dialog"'); expect(drawer).toContain('aria-modal="true"');
    expect(drawer).toContain('@keydown.escape.window="if(clienteFichaAberta) fecharFichaCliente()"');
    expect(drawer).toContain('Endereço não informado'); expect(drawer).toContain('Telefone não informado');
    expect(drawer).not.toContain('x-html'); expect(drawer).not.toContain('Carlos Oliveira');
    expect(html).not.toContain('<dialog id="cliente-ficha-dialog"');
    expect(html).not.toContain('Cliente selecionado');
    expect(html).not.toContain('<tr @click="abrirFichaCliente(c)"');
    expect(html.match(/@click(?:\.stop)?="abrirFichaCliente\(c\)"/g)).toHaveLength(3);
  });
});
