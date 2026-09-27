import {describe,it,expect,vi} from 'vitest';
vi.mock('../../../src/shared/config/env.js',()=>({env:{BOT_AUDIO_MODEL:'gpt-4o-mini-transcribe',OPENAI_API_KEY:'fake'}}));
import {privateMessage,privateReplyEligible} from '../../../src/marketing/organic/private-message.js';
import {extractOrganicInbound} from '../../../src/marketing/organic/inbound.js';
import {buildOrganicReport} from '../../../src/marketing/organic/report.js';
import {explicitRestockConsent} from '../../../src/atendente-v2/stock-interest.js';
import {insightValue} from '../../../src/marketing/organic/insights.js';
import {allowedAudioUrl,audioFormat,downloadAudio,transcribeAudio} from '../../../src/atendente-v2/audio-transcription.js';

describe('Fluxo orgânico',()=>{
  it('não inicia abordagem de comentário anterior à ativação, vencido ou sem intenção comercial',()=>{
    const now=new Date('2026-09-27T12:00:00Z'),input={action:'reply',commercial_intent:true,confidence_level:'high',removed:false,
      activated_at:'2026-09-27T00:00:00Z',occurred_at:'2026-09-27T11:00:00Z'};
    expect(privateReplyEligible(input,now)).toBe(true);
    expect(privateReplyEligible({...input,occurred_at:'2026-09-26T11:00:00Z'},now)).toBe(false);
    expect(privateReplyEligible({...input,activated_at:'2026-08-01',occurred_at:'2026-09-01'},now)).toBe(false);
    expect(privateReplyEligible({...input,commercial_intent:false},now)).toBe(false);
  });
  it('fecha com localização e não permite dados de contato na abordagem',()=>{
    expect(privateMessage('Opa! Temos 90/90-12 meia-vida por R$ 89,00 😊')).toBe('Opa! Temos 90/90-12 meia-vida por R$ 89,00 😊\n\nDe onde você está falando, meu amigo?');
    expect(()=>privateMessage('Chama em https://example.com')).toThrow();
  });
  it('não processa outras contas, eco ou remetente incompatível',()=>{
    const payload={object:'instagram',entry:[{id:'17841465774227389',messaging:[
      {sender:{id:'55'},recipient:{id:'17841465774227389'},timestamp:Date.now(),message:{mid:'m.1'}},
      {sender:{id:'55'},recipient:{id:'17841465774227389'},timestamp:Date.now(),message:{mid:'m.2',is_echo:true}},
    ]}]};
    expect(extractOrganicInbound(payload).map(r=>r.mid)).toEqual(['m.1']);
    expect(extractOrganicInbound({...payload,entry:[{...payload.entry[0],id:'other'}]})).toEqual([]);
  });
  it('só aceita consentimento afirmativo para reposição',()=>{
    expect(explicitRestockConsent('Pode me avisar no WhatsApp')).toBe(true);
    expect(explicitRestockConsent('Não quero que me avise')).toBe(false);
    expect(explicitRestockConsent('Quanto custa?')).toBe(false);
  });
  it('mede confirmação sem esperar entrega e remove cancelamentos sem duplicar pessoas',()=>{
    const period={id:'7d' as const,since:'2026-09-01',until:'2026-09-07',timezone:'America/Sao_Paulo'};
    const outs=[{id:'dm',status:'sent',sent_at:'2026-09-01T12:00:00Z'}];
    const sources=[{id:'s',outreach_id:'dm',conversation_id:'c',first_reply_at:'2026-09-01T12:01:00Z'}];
    const base={conversation_source_id:'s',conversation_id:'c',confirmed_at:'2026-09-01T12:11:00Z',first_reply_at:'2026-09-01T12:01:00Z',
      commented_at:'2026-09-01T11:59:00Z',private_sent_at:'2026-09-01T12:00:00Z',amount:178,refunded:0,order_number:1,chatwoot_conversation_id:2};
    const orders=[{...base,order_id:'1',cancelled:false,realized_at:null},
      {...base,order_id:'2',cancelled:false,realized_at:'2026-09-03T12:00:00Z',refunded:20},
      {...base,order_id:'3',cancelled:true,updated_at:'2026-09-04T12:00:00Z',realized_at:null}];
    const result=buildOrganicReport(period,outs,sources,orders,new Date('2026-09-07T12:00:00Z'));
    expect(result).toMatchObject({sales:1,revenue:158,conversations:1,converted_conversations:1,confirmed_orders:2,median_confirmation_minutes:10,confirmation_time_buckets:[2,0,0,0]});
    expect(result.sales_rows.map(r=>r.status)).toEqual(['completed','cancelled']);
    expect(result.sales_series.at(-1)?.sales).toBe(1);
  });
  it('ausência de insight não vira zero; não soma alcance de dias distintos',()=>{
    expect(insightValue({data:[]},'reach')).toBeNull();
    expect(insightValue({data:[{name:'reach',values:[{value:0}]}]},'reach')).toBe(0);
    expect(insightValue({data:[{name:'reach',values:[{value:2},{value:3}]}]},'reach')).toBeNull();
  });
});
describe('Áudio',()=>{
  it('bloqueia URLs fora da lista e redirecionamento interno antes de enviar credenciais',async()=>{
    expect(()=>allowedAudioUrl('http://media.example/audio',['media.example'])).toThrow();
    expect(()=>allowedAudioUrl('https://media.example@evil.test/a',['media.example'])).toThrow();
    const fetcher=vi.fn(async()=>new Response(null,{status:302,headers:{location:'https://127.0.0.1/a'}}));
    await expect(downloadAudio('https://media.example/audio',['media.example'],fetcher as any)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('detecta formato e envia transcrição multipart; falta de confiança permanece baixa',async()=>{
    const bytes=Buffer.from('OggS'+'a'.repeat(32));
    expect(audioFormat(bytes).ext).toBe('ogg');
    expect(()=>audioFormat(Buffer.from('<html>erro</html>'))).toThrow();
    const fetcher=vi.fn(async(_url:any,opts:any)=>{
      expect(opts.body.get('file').name).toBe('mensagem.ogg');expect(opts.body.get('language')).toBe('pt');
      return Response.json({text:'Quero dois pneus.'});
    });
    expect(await transcribeAudio(bytes,fetcher)).toEqual({text:'Quero dois pneus.',confidence:'low'});
    expect(await transcribeAudio(bytes,fetcher,async()=>{throw Error('metering_failed');})).toMatchObject({text:'Quero dois pneus.'});
  });
});
