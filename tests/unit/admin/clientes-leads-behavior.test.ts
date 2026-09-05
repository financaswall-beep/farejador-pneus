import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function setup() {
  const confirm = vi.fn(() => true);
  const fetcher = vi.fn(async () => ({ status:200,ok:true,json:async () => ({ version:1,archived:true,manual_lane:null }) }));
  const sandbox = createContext({ window:{ PAINEL_MODULES:{} },URL,Date,console,fetch:fetcher,confirm,
    crypto:{ randomUUID:() => 'idempotency-key' },alert:vi.fn(),lucide:{ createIcons:vi.fn() },
    document:{ getElementById:() => null },setTimeout,clearTimeout });
  for (const name of ['app.clientes.js','app.clientes.kanban.js','app.clientes.leads.js']) {
    runInContext(readFileSync(`painel/public/${name}`,'utf8'),sandbox);
  }
  const ui = runInContext('Object.assign({}, ...Object.values(window.PAINEL_MODULES).map(factory => factory()))',sandbox);
  Object.assign(ui,{ clientes:[],clientesBusca:'',clientesTipo:'todos',clientesOrigem:'todos',clientesStatus:'todos',
    clientesClasse:'todos',clientesPeriodo:'todos',adminAuthenticated:true,$nextTick:(f:() => void) => f(),
    apiHeaders:() => ({}),loadClientes:vi.fn(),apiGet:vi.fn(),
    adminUnauthorized() { this.adminAuthenticated = false; } });
  return { ui,confirm,fetcher };
}
const lead = (id:string,lane='novo',extras={}) => ({ id,name:id,source:'chatwoot',lead_conversation_id:id,
  lead_lane:lane,lead_derived_lane:lane,lead_board_version:0,lead_archived:false,origin:'whatsapp',...extras });

describe('Leads da Matriz — comportamento', () => {
  it('filtra os canais sem retirar pessoas que só existem no Facebook ou Instagram', () => {
    const { ui } = setup();
    ui.clientes = [lead('a','novo',{ origin:'Channel::Instagram',phone:null }),lead('b','novo',{ origin:'facebook' }),lead('c')];
    ui.clientesLeadCanal = 'instagram';
    expect(ui.clientesLeads('novo').map((c:{ id:string }) => c.id)).toEqual(['a']);
    ui.clientesLeadCanal = 'todos';
    expect(ui.clientesLeads('novo')).toHaveLength(3);
  });
  it('abre a conversa usando a conta da própria conversa, inclusive sem telefone', () => {
    const { ui } = setup(); ui.chatwootBaseUrl = 'https://chatwoot.example.test';
    expect(ui.clienteLeadConversaUrl(lead('a','novo',{ chatwoot_conversation_id:34,chatwoot_account_id:2,phone:null })))
      .toBe('https://chatwoot.example.test/app/accounts/2/conversations/34');
    expect(ui.clienteLeadConversaUrl(lead('a'))).toBe('');
  });
  it('arquiva somente concluídos carregados que correspondem aos filtros atuais', async () => {
    const { ui,fetcher,confirm } = setup();
    ui.clientes = [lead('novo'),lead('perdido','perdido'),lead('convertido','convertido'),
      lead('outro-canal','perdido',{ origin:'facebook' }),lead('ja-arquivado','perdido',{ lead_archived:true })];
    ui.clientesLeadCanal = 'whatsapp';
    await ui.arquivarClientesLeadLote(true);
    expect(fetcher.mock.calls.map((args:unknown[]) => args[0])).toEqual([
      '/admin/api/clientes/leads/perdido','/admin/api/clientes/leads/convertido',
    ]);
    expect(confirm.mock.calls[0]?.[0]).toContain('Arquivar 2');
    expect(ui.loadClientes).toHaveBeenCalledTimes(1);
    expect(ui.clientesLeadAviso).toContain('2 de 2');
    expect(ui.clientesLeadLote).toBeNull();
  });
  it('não envia nada quando o usuário cancela a limpeza', async () => {
    const { ui,confirm,fetcher } = setup(); confirm.mockReturnValue(false);
    ui.clientes = [lead('a','perdido')];
    await ui.arquivarClientesLeadLote(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reporta falha parcial sem declarar sucesso dos cards em conflito', async () => {
    const { ui,fetcher } = setup();
    ui.clientes = [lead('a'),lead('b')]; ui.clientesLeadMarcados = ['a','b'];
    fetcher.mockResolvedValueOnce({ status:409,ok:false,json:async () => ({ error:'lead_version_conflict' }) } as never);
    await ui.arquivarClientesLeadLote();
    expect(ui.clientesLeadAviso).toContain('1 de 2');
    expect(ui.clientesLeadMarcados).toEqual(['a']);
    expect(ui.clientesLeadErro).toContain('Alguns cards');
  });
  it('paralisa o lote após a sessão expirar', async () => {
    const { ui,fetcher } = setup(); ui.clientes = [lead('a','perdido'),lead('b','perdido')];
    fetcher.mockResolvedValueOnce({ status:401,ok:false,json:async () => ({}) } as never);
    await ui.arquivarClientesLeadLote(true);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(ui.loadClientes).not.toHaveBeenCalled();
  });
  it('retoma o automático sem confundir a etapa manual que coincide com a automática', async () => {
    const { ui,fetcher } = setup();
    const c = lead('a','orcamento',{ lead_manual_lane:'orcamento' });
    expect(ui.clienteLeadManual(c)).toBe(true);
    fetcher.mockResolvedValueOnce({ status:200,ok:true,json:async () => ({ version:2,archived:false,manual_lane:null }) });
    await ui.retomarClienteLeadAutomatico(c);
    const request = (fetcher.mock.calls[0] as unknown[])[1] as { body:string };
    expect(JSON.parse(request.body).action).toBe('automatic');
    expect(ui.clienteLeadManual(c)).toBe(false); expect(c.lead_lane).toBe('orcamento');
  });
  it('arrastar o card aplica a etapa manual e impede inventar uma venda convertida', async () => {
    const { ui,fetcher } = setup(); const c = lead('a'); ui.clientes = [c];
    const event = { dataTransfer:{ effectAllowed:'',setData:vi.fn() } };
    ui.clienteLeadDragStart(c,event);
    expect(event.dataTransfer.setData).toHaveBeenCalledWith('text/plain','a');
    fetcher.mockResolvedValueOnce({ status:200,ok:true,json:async () => ({ version:1,archived:false,manual_lane:'orcamento' }) });
    await ui.clienteLeadDrop('orcamento');
    expect(c.lead_lane).toBe('orcamento'); expect(ui.clienteLeadManual(c)).toBe(true);
    ui.clienteLeadDragStart(c,event); await ui.clienteLeadDrop('convertido');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(c.lead_lane).toBe('orcamento');
  });
  it('não permite arrastar cards arquivados nem convertidos por venda real', async () => {
    const { ui,fetcher } = setup();
    for (const c of [lead('a','convertido'),lead('b','novo',{ lead_archived:true })]) {
      const preventDefault = vi.fn(); ui.clientes = [c];
      ui.clienteLeadDragStart(c,{ preventDefault });
      expect(preventDefault).toHaveBeenCalled();
      await ui.clienteLeadDrop('orcamento');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('fotos ausentes ou inacessíveis mantêm as iniciais sem bloquear o quadro', async () => {
    const { ui } = setup(); const c = lead('a');
    ui.apiGet.mockResolvedValue({ avatar_url:'https://chatwoot.example.test/a.png' });
    ui.carregarClienteLeadFoto(c);
    await vi.waitFor(() => expect(ui.clienteLeadFoto(c)).toContain('a.png'));
    ui.clienteLeadFotoFalhou(c); expect(ui.clienteLeadFoto(c)).toBe('');
    ui.apiGet.mockRejectedValue(new Error('offline')); ui.carregarClienteLeadFoto(lead('b'));
    await vi.waitFor(() => expect(Object.hasOwn(ui.clientesLeadFotos,'b')).toBe(true));
    expect(ui.clienteLeadFoto(lead('b'))).toBe('');
  });
});
