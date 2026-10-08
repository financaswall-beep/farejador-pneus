import {describe,expect,it,vi} from 'vitest';
import {partnerScreen} from './helpers/partner-simple-dom.js';
const row={id:'request-1',request_number:'CMP-1',status:'dispatched',receipt_status:'pending',payment_status:'pending',total_cents:19500,
  items:[{item_id:'item-1',measure:'90/90-18',brand:'Pirelli',quantity:3,unit_price_cents:6500}]};
const reply=(body:unknown,ok=true)=>({ok,json:async()=>body});
async function orders(){
  const view=partnerScreen();view.ready();
  view.C.authenticatedFetch.mockImplementation(async(url:string)=>reply(url.endsWith('/pedidos')?{rows:[row]}:{rows:[],checkout_enabled:true}));
  view.C.partnerHome.open('partner-buy');
  await vi.waitFor(()=>expect(view.C.partnerBuy.state.loaded).toBe(true));
  await view.button('MEUS PEDIDOS').click();
  await vi.waitFor(()=>expect(view.root.textContent).toContain('CMP-1'));return view;
}
describe('compras próprias e recebimento',()=>{
  it('mostra estado, quantidade enviada e pagamento separado, e exige inteiro dentro do enviado',async()=>{
    const view=await orders();
    expect(view.root.textContent).toContain('Confirmar recebimento não confirma pagamento');
    const input=view.root.querySelectorAll('input').find(node=>node.attributes['aria-label']!=='Buscar medida no galpão')!;
    input.value='4';await input.fire('input');await view.button('CONFIRMAR RECEBIMENTO').click();
    expect(view.root.textContent).toContain('Informe uma quantidade entre zero e o total enviado');
    expect(view.C.authenticatedFetch.mock.calls.filter(([,o]:any[])=>o?.method==='POST')).toHaveLength(0);
  });
  it('mantém a chave no retry e bloqueia navegação e segundo envio durante a confirmação',async()=>{
    const view=await orders();const posts:any[]=[];
    let finish!:(value:unknown)=>void;
    view.C.authenticatedFetch.mockImplementation((url:string,opts:any)=>{
      if(opts?.method==='POST') {posts.push(JSON.parse(opts.body));return new Promise(resolve=>{finish=resolve;});}
      return Promise.resolve(reply({rows:[row]}));
    });
    const pending=view.button('CONFIRMAR RECEBIMENTO').click();
    expect(view.C.partnerBuy.busy()).toBe(true);
    const tab=view.C.partnerHome.currentTab();view.C.partnerHome.open('partner-home');
    expect(view.C.partnerHome.currentTab()).toBe(tab);expect(posts).toHaveLength(1);
    finish(reply({error:'network'},false));await pending;
    view.C.authenticatedFetch.mockImplementation(async(url:string,opts:any)=>{
      if(opts?.method==='POST'){posts.push(JSON.parse(opts.body));return reply({received:true});}
      return reply({rows:[{...row,receipt_status:'received',settled_total_cents:19500,items:[{...row.items[0],received_quantity:3}]}]});
    });
    await view.button('CONFIRMAR RECEBIMENTO').click();
    expect(posts[1]).toEqual(posts[0]);expect(view.root.textContent).toContain('Recebido · pagamento pendente');
    expect(view.button('CONFIRMAR RECEBIMENTO')).toBeUndefined();
  });
  it('funcionário sem compras pode ler mas não confirmar recebimento',async()=>{
    const view=await orders();view.storage.set('role','funcionario');view.C.partnerBuy.render('catalog');
    expect(view.root.textContent).toContain('CMP-1');expect(view.button('CONFIRMAR RECEBIMENTO')).toBeUndefined();
  });
});
