import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,expect,it,vi} from 'vitest';
function app(data:any={}){
  const events:any={},classes=new Set(),notice={textContent:''};
  const sheet:any={innerHTML:'',open:false,classList:{add:(s:string)=>classes.add(s),remove:(s:string)=>classes.delete(s)},
    setAttribute:vi.fn(),showModal(){this.open=true;},close(){this.open=false;events.close?.();},
    addEventListener:(name:string,fn:any)=>events[name]=fn,querySelector:()=>notice};
  const ch:any={state:{id:'one',session:'session',rows:[],drafts:new Map([['one','Rascunho']]),detail:{id:'one',name:'Cliente',channel_type:'whatsapp',photos:[]}},
    el:()=>sheet,escape:(v:any)=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'),
    icon:(name:string)=>`<svg data-icon="${name}"></svg>`,avatar:()=>'<span class="chat-avatar"></span>',
    currency:(value:any)=>'R$ '+Number(value||0).toFixed(2),updateAvatars:vi.fn(),errorText:()=> 'Erro ao carregar',
    path:(id:string)=>'/api/caixa/chat/conversations/'+id,api:vi.fn().mockResolvedValue(data)};
  const clipboard={writeText:vi.fn().mockResolvedValue(undefined)};
  runInNewContext(readFileSync('painel/public/caixa-chat-customer.js','utf8'),{window:{Caixa:{chat:ch}},navigator:{clipboard}});
  const click=(selector:string)=>events.click({target:{closest:(value:string)=>selector===value?{}:null}});
  return {ch,sheet,clipboard,notice,click,classes};
}
describe('ficha no chat da operação',()=>{
  it.each([['5521900000000','+55 (21) 90000-0000'],['+55 (21) 3000-0000','+55 (21) 3000-0000'],
    ['21900000000','(21) 90000-0000'],['2130000000','(21) 3000-0000'],['+1 202 555 0100','+1 202 555 0100']])('formata %s sem alterar telefones estrangeiros',async(raw,formatted)=>{
    const a=app({customer:{phone:raw,is_vip:false}});await a.ch.openCustomer();
    expect(a.sheet.innerHTML).toContain(formatted);await a.click('[data-customer-copy]');
    expect(a.clipboard.writeText).toHaveBeenCalledWith(formatted);expect(a.notice.textContent).toBe('Telefone copiado.');
  });
  it('usa VIP confirmado pelo servidor, imagens distintas e fallback neutro para tipo desconhecido',async()=>{
    const a=app({customer:{is_vip:true},summary:{purchases:5,total_spent:890},interests:[
      {measure:'130/70-13',vehicle_type:'motorcycle'},{measure:'175/65-14',vehicle_type:'car'},
      {measure:'90/90-12',vehicle_type:null}],orders:[]});await a.ch.openCustomer();
    expect(a.sheet.innerHTML).toContain('Cliente VIP');expect(a.sheet.innerHTML).toContain('/operacao/catalog-tire.webp');
    expect(a.sheet.innerHTML).toContain('/operacao/catalog-tire-car.png');expect(a.sheet.innerHTML).toContain('Tipo não identificado');
    expect(a.sheet.innerHTML).not.toContain('data-customer-copy');expect(a.sheet.innerHTML).toContain('R$ 890.00');
    expect(a.sheet.innerHTML).toContain('Compras concluídas');
  });
  it('não promove a VIP contando os pedidos exibidos ou usando um status ausente',async()=>{
    const a=app({customer:{is_vip:false},summary:{purchases:1},orders:Array.from({length:5},(_,id)=>({id,status:'cancelled'}))});
    await a.ch.openCustomer();expect(a.sheet.innerHTML).toContain('Cliente comum');expect(a.sheet.innerHTML).toContain('Compra concluída');
    a.ch.api.mockResolvedValue({customer:{},summary:{purchases:10}});await a.ch.openCustomer();
    expect(a.sheet.innerHTML).not.toContain('Cliente VIP');expect(a.sheet.innerHTML).toContain('Classificação indisponível');
  });
  it('expande o histórico e pagina sem duplicar pedidos ou modificar os totais',async()=>{
    const orders=Array.from({length:4},(_,id)=>({id:String(id),order_number:'Pedido '+id,total_amount:89}));
    const a=app({summary:{purchases:8,total_spent:712},orders,next_offset:4});await a.ch.openCustomer();
    expect(a.sheet.innerHTML).not.toContain('Pedido 3');await a.click('[data-customer-history]');
    expect(a.sheet.innerHTML).toContain('Pedido 3');
    a.ch.api.mockResolvedValue({orders:[orders[3],{id:'4',order_number:'Pedido 4'}],next_offset:null});
    await a.click('[data-customer-history]');await Promise.resolve();await Promise.resolve();
    expect(a.ch.api).toHaveBeenLastCalledWith('/api/caixa/chat/conversations/one/customer?offset=4');
    expect(a.sheet.innerHTML.match(/Pedido 3/g)).toHaveLength(1);expect(a.sheet.innerHTML).toContain('Pedido 4');expect(a.sheet.innerHTML).toContain('R$ 712.00');
  });
  it('descarta a ficha de uma sessão anterior e preserva o rascunho ao fechar',async()=>{
    const a=app();let resolve!:(value:any)=>void;a.ch.api.mockReturnValue(new Promise(r=>resolve=r));
    const pending=a.ch.openCustomer();a.sheet.close();a.ch.state.session='new';resolve({customer:{name:'Outro cliente'}});await pending;
    expect(a.sheet.innerHTML).not.toContain('Outro cliente');expect(a.ch.state.drafts.get('one')).toBe('Rascunho');expect(a.classes.has('chat-customer-sheet')).toBe(false);
  });
  it('escapa texto de contato e avisa quando a cópia é recusada',async()=>{
    const a=app({customer:{name:'<img src=x>',phone:'21900000000'}});await a.ch.openCustomer();
    expect(a.sheet.innerHTML).not.toContain('<img src=x>');a.clipboard.writeText.mockRejectedValue(Error('denied'));
    await a.click('[data-customer-copy]');expect(a.notice.textContent).toContain('Não foi possível copiar');
  });
});
