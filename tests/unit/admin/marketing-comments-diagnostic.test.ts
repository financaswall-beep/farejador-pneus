import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe,it,expect,vi } from 'vitest';

function panel(error: unknown) {
  const context = vm.createContext({window:{PAINEL_MODULES:{}}});
  vm.runInContext(readFileSync('painel/public/app.marketing.comments.js','utf8'),context);
  return {...context.window.PAINEL_MODULES.marketingComments(),mcoBusy:false,
    apiPost:vi.fn().mockRejectedValue(error)};
}
describe('diagnóstico dos comentários no painel',()=>{
  it('mostra a causa e a etapa sem exibir a resposta bruta da Meta',async()=>{
    const state=panel(Object.assign(new Error('meta_app_secret_mismatch'),{
      payload:{stage:'page',details:'secret-token'},
    }));
    await state.mcoConnection();
    expect(state.mcoConnectionMessage).toContain('Consulta da página.');
    expect(state.mcoConnectionMessage).toContain('META_APP_SECRET');
    expect(state.mcoConnectionMessage).not.toContain('secret-token');
    expect(state.mcoBusy).toBe(false);
  });
  it('informa token recusado e código da Meta',async()=>{
    const state=panel(Object.assign(new Error('meta_http_400_code_190'),{
      payload:{stage:'token_permissions'},
    }));
    await state.mcoConnection();
    expect(state.mcoConnectionMessage).toContain('Verificação das permissões');
    expect(state.mcoConnectionMessage).toContain('token instalado');
    expect(state.mcoConnectionMessage).toContain('190 (HTTP 400)');
  });
  it.each(['secret-token','constructor','__proto__'])('não expõe erros desconhecidos: %s',async(message)=>{
    const state=panel(new Error(message));
    await state.mcoConnection();
    expect(state.mcoConnectionMessage).toBe('Não foi possível validar a conexão. Tente novamente.');
  });
});
