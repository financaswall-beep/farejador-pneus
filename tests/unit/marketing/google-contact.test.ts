import Fastify from 'fastify';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({register:vi.fn()}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test',GOOGLE_ADS_ENABLED:true,GOOGLE_ADS_CUSTOMER_ID:'1234567890',GOOGLE_ADS_WHATSAPP_NUMBER:'5521972509411'}}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{}}));
vi.mock('../../../src/marketing/google-clicks.js',async original=>({...await original<object>(),registerGoogleClick:mocks.register}));
import {registerGoogleContactRoutes} from '../../../src/public/google-contact.route.js';
const click={campaign_id:'11',ad_group_id:'22',ad_id:'33',identifier_type:'gclid',identifier:'private-click',consent_ad_user_data:true,destination:'whatsapp'};
describe('Contato Google — consentimento e destino fixo',()=>{
  beforeEach(()=>mocks.register.mockReset());
  it('abre atendimento sem armazenar identificador quando nao ha consentimento',async()=>{
    const app=Fastify();await registerGoogleContactRoutes(app);
    try {
      const r=await app.inject({method:'POST',url:'/marketing/google/contact',headers:{'x-farejador-contact':'1'},payload:{destination:'whatsapp',measurement:false,click}});
      expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({measured:false});
      expect(r.json().url).toContain('https://wa.me/5521972509411');expect(r.json().url).not.toContain('private-click');
      expect(mocks.register).not.toHaveBeenCalled();
    } finally {await app.close();}
  });
  it('retorna somente referencia opaca e continua atendimento se banco falha',async()=>{
    const app=Fastify();await registerGoogleContactRoutes(app);
    try {
      mocks.register.mockResolvedValueOnce('2W-G'+'a'.repeat(32)).mockRejectedValueOnce(new Error('db_unavailable'));
      const send=()=>app.inject({method:'POST',url:'/marketing/google/contact',headers:{'x-farejador-contact':'1'},payload:{destination:'whatsapp',measurement:true,click}});
      const first=await send();expect(first.json().measured).toBe(true);expect(first.json().url).not.toContain('private-click');
      const second=await send();expect(second.statusCode).toBe(200);expect(second.json().measured).toBe(false);
    } finally {await app.close();}
  });
  it('recusa origem cross-site, consentimento falso, redirect arbitrario e site ainda indisponivel',async()=>{
    const app=Fastify();await registerGoogleContactRoutes(app);
    try {
      const send=(payload:object,headers={})=>app.inject({method:'POST',url:'/marketing/google/contact',headers:{'x-farejador-contact':'1',...headers},payload});
      expect((await send({destination:'whatsapp',measurement:false},{'sec-fetch-site':'cross-site'})).statusCode).toBe(403);
      expect((await send({destination:'whatsapp',measurement:true,click:{...click,consent_ad_user_data:false}})).statusCode).toBe(400);
      expect((await send({destination:'whatsapp',measurement:false,url:'https://attacker.example'})).statusCode).toBe(400);
      expect((await send({destination:'web',measurement:false})).statusCode).toBe(409);
      expect(mocks.register).not.toHaveBeenCalled();
    } finally {await app.close();}
  });
});
