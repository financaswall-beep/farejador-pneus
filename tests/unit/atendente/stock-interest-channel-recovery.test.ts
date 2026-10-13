import {beforeEach,describe,expect,it,vi} from 'vitest';
import {formatCustomerContext} from '../../../src/atendente-v2/customer-context.js';
import {registerStockInterest} from '../../../src/atendente-v2/stock-interest.js';
const text='Mudei de ideia. Autorizo que me avisem pelo WhatsApp quando chegar 1 pneu de moto 100/80-16 meia-vida. Meu WhatsApp com DDD é +5521988887777. Só lista de espera, sem pedido ou reserva.';
const data={acao:'registrar',medida:'100/80-16',condicao:'meia_vida',consentimento:text,quantidade:1,tipo_veiculo:'motorcycle'};
let recent:any[],query:ReturnType<typeof vi.fn>;
beforeEach(()=>{recent=[{id:'m1',content:text,sent_at:new Date(),chatwoot_message_id:1}];
  query=vi.fn().mockImplementation(async(sql:string)=>{
    if(sql.includes('SELECT id,content'))return {rows:recent};
    if(sql.includes('SELECT content,message_type'))return {rows:[]};
    if(sql.includes('SELECT c.channel_type'))return {rows:[{channel_type:'Channel::Api',phone_e164:'+5521988887777'}]};
    if(sql.includes('catalog_vehicle_type'))return {rows:[{type:'motorcycle'}]};
    if(sql.includes('INSERT INTO ops.stock_interests'))return {rows:[{id:'saved'}],rowCount:1};
    return {rows:[],rowCount:0};
  });});
describe('lista de espera em canal sem telefone automático',()=>{
  it('recupera somente telefone explícito da mensagem quando omitido pela tool',async()=>{
    expect(await registerStockInterest({query} as never,'test','conv',data)).toMatchObject({registrado:true});
    const insert=query.mock.calls.find(([sql])=>sql.includes('INSERT INTO ops.stock_interests'));
    expect(insert?.[1][5]).toBe('+5521988887777');expect(insert?.[1][6]).toBe(text);
  });
  it('usa o texto inteiro verificado quando o modelo recorta um consentimento explícito',async()=>{
    expect(await registerStockInterest({query} as never,'test','conv',{...data,consentimento:'Autorizo que me avisem pelo WhatsApp quando chegar 1 pneu de moto 100/80-16 meia-vida.'})).toMatchObject({registrado:true});
    const insert=query.mock.calls.find(([sql])=>sql.includes('INSERT INTO ops.stock_interests'));expect(insert?.[1][6]).toBe(text);
  });
  it('não usa cadastro de canal API sem telefone explicitamente informado',async()=>{
    recent[0].content='Pode me avisar no WhatsApp quando chegar';
    expect(await registerStockInterest({query} as never,'test','conv',{...data,consentimento:recent[0].content})).toMatchObject({erro:'consentimento_ou_telefone_pendente'});
  });
  it('não completa telefone inválido e não decide entre dois números',async()=>{
    expect(await registerStockInterest({query} as never,'test','conv',{...data,telefone:'2198765565'})).toMatchObject({erro:'consentimento_ou_telefone_pendente'});
    recent[0].content=text+' Outro WhatsApp: 21 99999-8888.';
    expect(await registerStockInterest({query} as never,'test','conv',{...data,consentimento:recent[0].content})).toMatchObject({erro:'consentimento_ou_telefone_pendente'});
  });
  it('não reaproveita aceite recortado de uma mensagem com recusa',async()=>{
    recent[0].content='Autorizo que me avisem pelo WhatsApp, mas não quero receber aviso agora.';
    expect(await registerStockInterest({query} as never,'test','conv',{...data,consentimento:'Autorizo que me avisem pelo WhatsApp'})).toMatchObject({erro:'autorizacao_nao_confirmada'});
  });
  it.each(['Não quero mais receber esse aviso.','Cancele minha lista de espera.','Não quero ser avisado.','Cancele minha inscrição.'])('respeita recusa posterior: %s',async refusal=>{
    recent.unshift({id:'m2',content:refusal,sent_at:new Date(),chatwoot_message_id:2});
    expect(await registerStockInterest({query} as never,'test','conv',data)).toMatchObject({erro:'novo_consentimento_necessario'});
    expect(query.mock.calls.some(([sql])=>sql.includes('INSERT INTO ops.stock_interests'))).toBe(false);
  });
  it('contexto diferencia cadastro WhatsApp e telefone confirmado em texto em outros canais',()=>{
    const row={name:'Ana',has_phone:true,phone_e164:'+5521988887777',purchase_count:0,partial_ltv_brl:null,last_purchase_at:null,last_purchase_item:null,has_previous_delivery_address:false};
    const api=formatCustomerContext({...row,channel_type:'Channel::Api'} as never);
    expect(api).not.toContain('omita registrar_interesse_reposicao.telefone');expect(api).toContain('informado por texto');
    const whatsapp=formatCustomerContext({...row,channel_type:'Channel::Whatsapp'} as never);
    expect(whatsapp).toContain('omita registrar_interesse_reposicao.telefone');expect(whatsapp).not.toContain('+5521');
  });
});
