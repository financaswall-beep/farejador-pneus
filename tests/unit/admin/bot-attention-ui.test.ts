import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe,expect,it,vi } from 'vitest';
function setup() {
  const sandbox={ window:{ PAINEL_MODULES:{} as Record<string,()=>object> },
    document:{ getElementById:()=>null },console,URL };
  for (const name of ['app.bot.js','app.bot.controle.js','app.clientes.js','app.clientes.leads.js']) {
    runInNewContext(readFileSync(`painel/public/${name}`,'utf8'),sandbox);
  }
  const ui:Record<string,any>={};
  for (const factory of Object.values(sandbox.window.PAINEL_MODULES)) Object.defineProperties(ui,Object.getOwnPropertyDescriptors(factory()));
  Object.assign(ui,{ adminAuthenticated:true,hasPanelModule:()=>true,$nextTick:(f:()=>void)=>f(),
    apiGet:vi.fn(),apiPost:vi.fn(),botConversaFiltro:'todos',botConversaBusca:'' });
  return ui;
}
describe('fila de atenção e controle azul',() => {
  it('preserva a conversa, a foto e o canal ao mesclar esperando, escalados e controle humano',() => {
    const ui=setup();ui.botCampainha={ mudas:[{ conversation_id:'a',contact_name:'Ana',channel_type:'Channel::Instagram',bot_mode:'human' }],
      escalados:[{ conversation_id:'b',contact_name:'Bruno',channel_type:'Channel::Facebook',bot_mode:'auto' }] };
    ui.botControlesHumanos=[{ conversation_id:'a',contact_name:'Ana',updated_at:new Date().toISOString() },
      { conversation_id:'c',contact_name:'Carla',channel_type:'Channel::Whatsapp',updated_at:new Date().toISOString() }];
    expect(ui.botConversasFila).toHaveLength(3);
    const channels=Object.fromEntries(ui.botConversasFila.map((row:any)=>[row.conversation_id,ui.clienteLeadCanal(row)]));
    expect(channels).toEqual({ a:'instagram',b:'facebook',c:'whatsapp' });
    expect(ui.botConversasFila.find((row:any)=>row.conversation_id==='a')).toMatchObject({ lead_conversation_id:'a',bot_mode:'human' });
  });
  it('reutiliza foto com endpoint autorizado do Bot e fallback sem imagem quebrada',async () => {
    const ui=setup(),row={ lead_conversation_id:'a' };
    ui.apiGet.mockResolvedValue({ avatar_url:'https://chatwoot.example.test/a.png' });
    ui.carregarClienteLeadFoto(row,'bot');ui.carregarClienteLeadFoto(row,'bot');
    await vi.waitFor(()=>expect(ui.clienteLeadFoto(row)).toContain('a.png'));
    expect(ui.apiGet).toHaveBeenCalledTimes(1);
    expect(ui.apiGet).toHaveBeenCalledWith('/admin/api/bot/conversations/a/avatar');
    ui.clienteLeadFotoFalhou(row);expect(ui.clienteLeadFoto(row)).toBe('');
  });
  it('padroniza azul para auto, âmbar para humano e neutro para estado desconhecido',() => {
    const ui=setup();
    expect(ui.botControleClasse('auto')).toContain('bg-blue-600');
    expect(ui.botControleClasse('human')).toContain('bg-amber-50');
    expect(ui.botControleClasse(null)).not.toContain('bg-blue-600');
    ui.botControleModos.a=null;
    expect(ui.botControleModo('a','auto')).toBeNull();
    expect(ui.botControleModo('b','auto')).toBe('auto');
    // O Alpine precisa observar a leitura da chave ausente para atualizar a cor após o GET.
    const read=vi.fn((target:Record<string,unknown>,key:string)=>target[key]);
    ui.botControleModos=new Proxy({},{ get:read });
    expect(ui.botControleModo('novo')).toBeNull();
    expect(read).toHaveBeenCalledWith(expect.any(Object),'novo',expect.any(Object));
    ui.botControleModos.novo='auto';
    expect(ui.botControleModo('novo')).toBe('auto');
  });
  it('atualiza apenas o controle escolhido após confirmação e trata falha sem presumir retomada',async () => {
    const ui=setup();ui.apiGet.mockResolvedValueOnce({ mode:'auto',version:0 });
    await ui.abrirControleBot('a','Ana');
    ui.botControleModos.b='auto';
    ui.apiPost.mockResolvedValue({ mode:'human',version:1 });
    ui.apiGet.mockResolvedValue({ conversations:[] });
    await ui.alterarControleBot('takeover');
    expect(ui.botControleModo('a')).toBe('human');expect(ui.botControleModo('b')).toBe('auto');
    ui.apiPost.mockRejectedValue(new Error('offline'));await ui.alterarControleBot('resume');
    expect(ui.botControleModo('a')).toBeNull();expect(ui.botControleDialog.state).toBeNull();
  });
  it('usa o mesmo estilo nos dois atalhos e no modal, com foto e coluna Origem na fila',() => {
    const html=readFileSync('painel/public/index.html','utf8');
    const table=html.slice(html.indexOf('id="bot-fila-atencao"'),html.indexOf('</table>',html.indexOf('id="bot-fila-atencao"')));
    expect(table).toContain('>Origem</th>');expect(table).toContain('clienteOrigemIcone(c)');
    expect(table).toContain("carregarClienteLeadFoto(c,'bot')");expect(table).toContain('clienteLeadFotoFalhou(c)');
    expect(table).toContain(':key="c.conversation_id"');
    expect((html.match(/:class="botControleClasse\(/g)||[])).toHaveLength(3);
  });
});
