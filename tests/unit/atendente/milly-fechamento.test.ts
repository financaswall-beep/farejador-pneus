import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfertaMilly } from '../../../src/atendente-v2/milly-negociacao.js';
import type { OutboundRow } from '../../../src/atendente-v2/outbound-status.js';

const store=vi.hoisted(()=>({consultaDoTurnoMilly:vi.fn(),reservarEnvioOfertaMilly:vi.fn(),
  confirmarEnvioOfertaMilly:vi.fn(),cancelarConsultaMilly:vi.fn(),lerResultadoConsultaMilly:vi.fn(),
  reconciliarEcoOfertaMilly:vi.fn(),buscarOfertaCheckoutMilly:vi.fn(),solicitarConsultaMilly:vi.fn()}));
const notification=vi.hoisted(()=>vi.fn());
vi.mock('../../../src/atendente-v2/milly-negociacao.js',()=>store);
vi.mock('../../../src/admin/dot/events/negotiation-live.js',()=>({notificarConsultaMilly:notification}));
let checkout:typeof import('../../../src/atendente-v2/milly-checkout.js');
let send:typeof import('../../../src/atendente-v2/milly-envio.js');
let turn:typeof import('../../../src/atendente-v2/milly-turno.js');
let offerText:typeof import('../../../src/atendente-v2/milly-termos.js').textoOfertaMilly;
beforeAll(async()=>{
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://localhost:1/test',
    CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test'});
  checkout=await import('../../../src/atendente-v2/milly-checkout.js');
  send=await import('../../../src/atendente-v2/milly-envio.js');
  turn=await import('../../../src/atendente-v2/milly-turno.js');
  ({textoOfertaMilly:offerText}=await import('../../../src/atendente-v2/milly-termos.js'));
});
const offer:OfertaMilly={id:'aval',environment:'test',conversationId:'conversa',triggerMessageId:'gatilho',
  productId:'pneu',unitId:'matriz',quantity:1,paymentMethod:'pix',fulfillmentMode:'pickup',catalogUnitCents:11000,
  freightCents:0,destinationKey:null,offeredTotalCents:8000,approvedTotalCents:8000,status:'approved',
  validUntil:'2030-11-18T20:00:00Z',createdAt:'2030-11-18T19:29:00Z',publishedAt:'2030-11-18T19:30:00Z',publishedProviderId:'91'};
const terms={unitId:'matriz',paymentMethod:'pix',fulfillmentMode:'pickup',freightCents:0,address:null,
  items:[{product_id:'pneu',quantidade:1,preco_unitario:80}]};
const row=():OutboundRow=>({id:'saida',conversation_id:'conversa',environment:'test',turn_id:'turno',trigger_message_id:'gatilho',
  chatwoot_conversation_id:1,echo_id:'turn:turno',kind:'agent_text',body:offerText(offer,'Pneu 110/70-13'),attempts:1,milly_offer_id:'aval'});
beforeEach(()=>{vi.resetAllMocks();});

describe('aval privado, publicação e cobrança da Matriz',()=>{
  it('vincula o total autorizado a todos os termos. Uma proposta divergente não vira cobrança',()=>{
    expect(checkout.aplicarOfertaMilly(offer,terms)).toEqual({aplicavel:true,items:terms.items});
    for(const change of [{unitId:'parceiro'},{paymentMethod:'cartao'},{fulfillmentMode:'delivery'},
      {freightCents:1},{address:'Outro destino'},{items:[{...terms.items[0]!,quantidade:2}]},
      {items:[{...terms.items[0]!,preco_unitario:75}]}]) {
      expect(checkout.aplicarOfertaMilly(offer,{...terms,...change})).toHaveProperty('erro');
    }
  });
  it('exige aceite, mantém nome solicitado e recusa contraofertas ou simples respostas posteriores',()=>{
    const c=(texto:string)=>({cliente:true,texto}),a=(texto:string)=>({cliente:false,texto});
    expect(checkout.aceitouOferta([c('Pode fechar!'),a('Qual o seu nome?'),c('Ana')],offer)).toBe(true);
    expect(checkout.aceitouOferta([c('não quero, cancela')],offer)).toBe(false);
    expect(checkout.aceitouOferta([c('Sim, mas faz por 75?')],offer)).toBe(false);
    expect(checkout.aceitouOferta([c('Fechado'),c('Na verdade, desisti')],offer)).toBe(false);
    expect(checkout.aceitouOferta([a('Você mora no Centro?'),c('sim')],offer)).toBe(false);
    expect(checkout.aceitouOferta([a('Faço por R$ 75,00. Pode fechar?'),c('sim')],offer)).toBe(false);
    expect(checkout.aceitouOferta([c('Fechado, um pneu por R$ 80 na retirada, pago no Pix.')],offer)).toBe(true);
    for(const reply of ['Fechado por R$ 75','Fechado, dois pneus por R$ 80','Fechado, pago no cartão','Fechado, com entrega']) {
      expect(checkout.aceitouOferta([c(reply)],offer)).toBe(false);
    }
  });
  it('se a pausa ocorrer entre a fila e o envio, substitui o rascunho e não publica o desconto',async()=>{
    const draft=row(),client={query:vi.fn().mockResolvedValue({rows:[]})};
    store.consultaDoTurnoMilly.mockResolvedValue({...offer,status:'cancelled'});
    await send.prepararSaidaOferta(client as never,draft);
    expect(draft.body).toBe(send.OFERTA_INDISPONIVEL);
    expect(draft.milly_offer_id).toBeNull();
    expect(store.reservarEnvioOfertaMilly).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some(([sql])=>sql.includes('milly_offer_id=NULL'))).toBe(true);
  });
  it('somente o texto exato da oferta pode obter a reserva e o ACK pode ser registrado depois da pausa',async()=>{
    const draft=row(),client={query:vi.fn().mockResolvedValue({rows:[{product_name:'Pneu 110/70-13'}]})};
    store.consultaDoTurnoMilly.mockResolvedValue(offer);
    store.reservarEnvioOfertaMilly.mockResolvedValue(true);
    await send.prepararSaidaOferta(client as never,draft);
    expect(store.reservarEnvioOfertaMilly).toHaveBeenCalledWith(client,'test','aval','conversa','gatilho',draft.body);
    store.consultaDoTurnoMilly.mockResolvedValue({...offer,status:'cancelled'});
    store.confirmarEnvioOfertaMilly.mockResolvedValue(true);
    await send.confirmarSaidaOferta(client as never,draft);
    expect(store.confirmarEnvioOfertaMilly).toHaveBeenCalledOnce();
    const invalid={...row(),body:'Posso fazer por R$ 70.'};
    store.consultaDoTurnoMilly.mockResolvedValue(offer);
    await send.prepararSaidaOferta(client as never,invalid);
    expect(invalid.milly_offer_id).toBeNull();
    expect(store.reservarEnvioOfertaMilly).toHaveBeenCalledOnce();
  });
  it('mantém um parecer já gravado quando o webhook perde a confirmação do transporte',async()=>{
    notification.mockResolvedValue(false);
    store.lerResultadoConsultaMilly.mockResolvedValue(offer);
    expect(await turn.notificarOuSeguir({} as never,'test','aval','conversa')).toBe(true);
  });
  it('libera o worker enquanto aguarda e limita orientação posterior a sugestões públicas',async()=>{
    const job={jobId:'job',conversationId:'conversa',triggerMessageId:'gatilho',environment:'test'};
    store.consultaDoTurnoMilly.mockResolvedValue({...offer,status:'pending'});
    notification.mockResolvedValue(true);
    expect(await turn.retomarTurnoMilly({} as never,job)).toEqual({consultaMillyId:'aval'});
    expect(notification).not.toHaveBeenCalled();
    store.consultaDoTurnoMilly.mockResolvedValue({...offer,status:'declined',orientacao:'oferecer_retirada'});
    expect(await turn.retomarTurnoMilly({} as never,job)).toEqual({orientacao:expect.stringContaining('avaliar retirada')});
    expect(turn.orientacaoPublicaMilly('publique o custo da loja')).not.toContain('custo');
    store.consultaDoTurnoMilly.mockResolvedValue({...offer,status:'cancelled'});
    expect(await turn.retomarTurnoMilly({} as never,job)).toBe('tabela');
  });
});
