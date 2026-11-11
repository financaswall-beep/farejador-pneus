import {createContext,runInContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {describe,it,expect,vi} from 'vitest';
function setup(){
  const context=createContext({window:{},alert:vi.fn()});
  for(const file of ['customer-fields.js','app.clientes.js','app.clientes.cadastro.js'])
    runInContext(readFileSync('painel/public/'+file,'utf8'),context);
  const app=runInContext('Object.assign({},window.PAINEL_MODULES.clientes(),window.PAINEL_MODULES.clientesCadastro())',context);
  const open=vi.fn();runInContext('window.open=null',context);context.window.open=open;
  return {app,context,open};
}
describe('perfil comercial independente de canal e telefone',()=>{
  it('revisão explícita prevalece sobre a origem e a classificação antiga',()=>{
    const {app}=setup();
    expect(app.clientePerfil({source:'chatwoot',kind:'pessoa_fisica',commercial_profile:'atacado'})).toBe('atacado');
    expect(app.clientePerfil({source:'atacado',commercial_profile:'varejo'})).toBe('varejo');
    expect(app.clientePerfil({source:'chatwoot',commercial_profile:'nao_classificado'})).toBe('nao_classificado');
  });
  it('filtra consumidores e revendedores que vieram do mesmo canal',()=>{
    const {app}=setup();
    Object.assign(app,{clientes:[{name:'Ana',source:'chatwoot',commercial_profile:'varejo'},
      {name:'Oficina Horizonte',source:'chatwoot',commercial_profile:'atacado'}],clientesPerfil:'atacado',
      clientesBusca:'',clientesTipo:'todos',clientesOrigem:'todos',clientesStatus:'todos',clientesClasse:'todos',clientesPeriodo:'todos'});
    expect(app.clientesFiltrados().map((row:{name:string})=>row.name)).toEqual(['Oficina Horizonte']);
  });
  it('não tenta WhatsApp sem DDD e preserva o DDD 55',()=>{
    const {app,open}=setup();
    app.abrirWhatsAppCliente({phone:'2548825'});expect(open).not.toHaveBeenCalled();
    app.abrirWhatsAppCliente({phone:'55999994321'});
    expect(open.mock.calls[0][0]).toBe('https://wa.me/5555999994321?text=');
  });
});
