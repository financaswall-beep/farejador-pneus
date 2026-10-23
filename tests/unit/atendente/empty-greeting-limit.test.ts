import {describe,expect,it,vi} from 'vitest';
vi.hoisted(()=>Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',
  DATABASE_SSL:'false',CHATWOOT_HMAC_SECRET:'unit-test',ADMIN_AUTH_TOKEN:'unit-test'}));
import {isEmptyGreeting,hasRepeatedEmptyGreetings} from '../../../src/atendente-v2/empty-greeting-limit.js';
describe('cumprimentos repetidos sem intenção',()=>{
  it.each(['Oi!','Bom dia!','Boa noite!','Opa, tudo bem?','Olá 👋','E aí, beleza?'])('reconhece %s',text=>expect(isEmptyGreeting(text)).toBe(true));
  it.each(['Oi, tem pneu 90/90-18?','Bom dia, sou do Méier','Tudo bem, quero cancelar','Boa noite, não entendi','[O cliente enviou uma imagem.]'])('não descarta intenção em %s',text=>expect(isEmptyGreeting(text)).toBe(false));
  it('encaminha no terceiro cumprimento consecutivo e não no segundo',()=>{
    const history:any[]=[{role:'user',content:'Oi!'},{role:'assistant',content:'Como posso ajudar?'},{role:'user',content:'Bom dia!'}];
    expect(hasRepeatedEmptyGreetings(history)).toBe(false);history.push({role:'assistant',content:'O que precisa?'},{role:'user',content:'Opa, tudo bem?'});
    expect(hasRepeatedEmptyGreetings(history)).toBe(true);
  });
  it('mensagem com intenção ou anexo reinicia a contagem',()=>{
    const history:any[]=[{role:'user',content:'Oi!'},{role:'user',content:'Bom dia!'},{role:'user',content:'Quero pneu 90/90-18'},{role:'user',content:'Opa!'}];
    expect(hasRepeatedEmptyGreetings(history)).toBe(false);
  });
});
