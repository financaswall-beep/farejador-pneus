import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {StockRequest} from '../../../src/atendente-v2/stock-confirmation-store.js';
const mocks=vi.hoisted(()=>({map:vi.fn()}));
vi.mock('../../../src/atendente-v2/fulfillment.js',()=>({mapProductToPartnerStock:mocks.map}));
const request={id:'request',unit_id:'unit',status:'confirmed',valid_until:new Date(Date.now()+60000),
  routing:{location:{municipio:'Rio de Janeiro',clientNeighborhoodCanonical:'meier'},items:[{product_id:'p1',quantity:1},{product_id:'p2',quantity:2}]},
  items:[{tire_size:'90/90-18',quantity:1,price:55},{tire_size:'140/70-17',quantity:2,price:89.9}]} as unknown as StockRequest;
beforeEach(()=>{vi.resetAllMocks();Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://unused',
  CHATWOOT_HMAC_SECRET:'fake',ADMIN_AUTH_TOKEN:'fake',PARTNER_STOCK_CONFIRMATION:'true'});
  mocks.map.mockImplementation(async(_c,_e,_u,id)=>({partner_stock_id:id,unit_price:id==='p1'?55:89.9,tire_size:id==='p1'?'90/90-18':'140/70-17'}));});
const client=()=>({query:vi.fn().mockResolvedValue({rows:[{name:'Borracharia Teste',hours:[0,1,2,3,4,5,6].map(day=>({day,opens_at:'00:00',closes_at:'23:59'}))}]})});
describe('confirmação atual disponível ao agente',()=>{
  it('informa os dois produtos, suas quantidades e a mesma loja após TENHO',async()=>{
    const {loadConfirmedStockFacts,confirmedStockPrompt}=await import('../../../src/atendente-v2/confirmed-stock-context.js');
    const facts=await loadConfirmedStockFacts(client() as never,'test',request);
    expect(facts?.items).toHaveLength(2);expect(facts?.storeName).toBe('Borracharia Teste');
    const prompt=confirmedStockPrompt(facts);expect(prompt).toContain('p1');expect(prompt).toContain('p2');
    expect(prompt).toContain('mesma loja');expect(prompt).toContain('localizacao_loja');
  });
  it.each(['pending','cancelled','expired','exhausted'])('não transforma %s em confirmação',async status=>{
    const {loadConfirmedStockFacts}=await import('../../../src/atendente-v2/confirmed-stock-context.js');
    expect(await loadConfirmedStockFacts(client() as never,'test',{...request,status})).toBeNull();expect(mocks.map).not.toHaveBeenCalled();
  });
  it('não reutiliza confirmação vencida',async()=>{
    const {loadConfirmedStockFacts}=await import('../../../src/atendente-v2/confirmed-stock-context.js');
    expect(await loadConfirmedStockFacts(client() as never,'test',{...request,valid_until:new Date(0)})).toBeNull();
  });
  it('não confirma se a loja fechou ou o saldo não atende o conjunto',async()=>{
    const {loadConfirmedStockFacts}=await import('../../../src/atendente-v2/confirmed-stock-context.js');
    const c=client();c.query.mockResolvedValue({rows:[{name:'Loja',hours:[]}]});
    expect(await loadConfirmedStockFacts(c as never,'test',request)).toBeNull();
    mocks.map.mockResolvedValue(null);expect(await loadConfirmedStockFacts(client() as never,'test',request)).toBeNull();
  });
  it('corrige negação de TENHO e identifica preço alterado como alteração da loja',async()=>{
    const {loadConfirmedStockFacts,guardConfirmedStockReply}=await import('../../../src/atendente-v2/confirmed-stock-context.js');
    const facts=await loadConfirmedStockFacts(client() as never,'test',request);
    expect(guardConfirmedStockReply('A loja ainda não confirmou se tem.',facts)).toContain('A loja confirmou');
    expect(guardConfirmedStockReply('Não consigo confirmar os dois na mesma loja.',facts)).toContain('mesma loja');
    mocks.map.mockImplementation(async(_c,_e,_u,id)=>({partner_stock_id:id,unit_price:id==='p1'?57.5:89.9,tire_size:'90/90-18'}));
    const changed=await loadConfirmedStockFacts(client() as never,'test',request);
    expect(guardConfirmedStockReply('Passei 55 sem confirmação da loja.',changed)).toContain('alterou');
    expect(guardConfirmedStockReply('Passei 55 sem confirmação da loja.',changed)).toContain('57,50');
  });
  it('preserva resposta normal e não sobrepõe confirmação inexistente',async()=>{
    const {guardConfirmedStockReply}=await import('../../../src/atendente-v2/confirmed-stock-context.js');
    expect(guardConfirmedStockReply('Seu pedido já foi entregue.',null)).toBe('Seu pedido já foi entregue.');
  });
  it('não confunde confirmação de estoque com foto, instalação ou pedido criado',async()=>{
    const {loadConfirmedStockFacts,guardConfirmedStockReply,guardCurrentConfirmedStockReply}=await import('../../../src/atendente-v2/confirmed-stock-context.js');
    const facts=await loadConfirmedStockFacts(client() as never,'test',request);
    const photo='A loja ainda não confirmou se tem a foto.';
    expect(guardConfirmedStockReply(photo,facts)).toBe(photo);
    const c=client();const body='Preço e pedido confirmados.';
    const action=(name:string,result:unknown):any[]=>[{role:'assistant',content:null,tool_calls:[{id:'call',type:'function',function:{name,arguments:'{}'}}]},
      {role:'tool',tool_call_id:'call',content:JSON.stringify(result)}];
    expect(await guardCurrentConfirmedStockReply(c as never,'test','conv',body,action('criar_pedido',{ok:true}))).toBe(body);
    expect(await guardCurrentConfirmedStockReply(c as never,'test','conv','A loja não confirmou se tem.',action('buscar_produto',{encontrado:false}))).toBe('A loja não confirmou se tem.');
    expect(c.query).not.toHaveBeenCalled();
  });
  it('bloqueia apenas encaminhamento por suposta impossibilidade de confirmar a mesma loja',async()=>{
    const {correctConfirmedStockHandoff}=await import('../../../src/atendente-v2/confirmed-stock-context.js');
    const c=client();c.query.mockImplementation(async(sql:string)=>({rows:sql.includes('partner_stock_requests')?[request]
      :[{name:'Borracharia Teste',hours:[0,1,2,3,4,5,6].map(day=>({day,opens_at:'00:00',closes_at:'23:59'}))}]}));
    const args={motivo:'duvida_complexa',resumo:'As ferramentas não permitem confirmar se os dois pneus são da mesma loja.'};
    const correction=await correctConfirmedStockHandoff(c as never,'test','conv',args,'Pode verificar e fechar os dois?',[]);
    expect(JSON.parse(correction!)).toMatchObject({erro:'conjunto_ja_confirmado',confirmacao:{storeName:'Borracharia Teste'}});
    c.query.mockClear();
    expect(await correctConfirmedStockHandoff(c as never,'test','conv',args,'Quero falar com um atendente.',[])).toBeNull();
    expect(await correctConfirmedStockHandoff(c as never,'test','conv',{...args,motivo:'cliente_pediu'},'Pode verificar?',[])).toBeNull();
    expect(await correctConfirmedStockHandoff(c as never,'test','conv',{...args,resumo:'Cliente reclama de pneu danificado.'},'Pode verificar?',[])).toBeNull();
    expect(c.query).not.toHaveBeenCalled();
    c.query.mockResolvedValue({rows:[{...request,status:'cancelled'}]});
    expect(await correctConfirmedStockHandoff(c as never,'test','conv',args,'Pode verificar?',[])).toBeNull();
  });
});
