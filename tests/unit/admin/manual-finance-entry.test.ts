import {createContext,runInContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {describe,it,expect,vi} from 'vitest';
import {manualEntrySchema,reverseManualEntrySchema} from '../../../src/admin/painel/manual-finance-entry-schema.js';
const body={kind:'income',category:'servicos',amount:150.5,occurred_at:'2026-09-02T12:00:00-03:00',description:'Serviço avulso',
  payment_method:'pix',cash_account:'Caixa principal',idempotency_key:'10000000-0000-4000-8000-000000000001'};
describe('contrato de entrada financeira humana',()=>{
  it('aceita receita ou aporte com classificação definida pelo servidor',()=>{
    expect(manualEntrySchema.parse(body)).toMatchObject({amount:150.5,kind:'income'});
    expect(manualEntrySchema.parse({...body,kind:'owner_contribution',category:undefined})).toMatchObject({kind:'owner_contribution'});
  });
  it.each([{amount:0},{amount:-1},{amount:1.001},{amount:Infinity},{category:undefined},{description:' '},
    {occurred_at:'2099-01-01T00:00:00Z'},{occurred_at:'2026-02-30T12:00:00Z'},
    {kind:'sale'},{payment_method:'a_receber'},{environment:'prod'},{account_code:'sales_revenue'}])('recusa campos inválidos ou conta/ambiente arbitrários',patch=>{
    expect(manualEntrySchema.safeParse({...body,...patch}).success).toBe(false);
  });
  it('exige motivo e data válida para correção',()=>{
    expect(reverseManualEntrySchema.safeParse({reason:'Erro',occurred_at:body.occurred_at,idempotency_key:body.idempotency_key}).success).toBe(true);
    expect(reverseManualEntrySchema.safeParse({reason:'',occurred_at:body.occurred_at,idempotency_key:body.idempotency_key}).success).toBe(false);
  });
});
function ui(){
  const ctx=createContext({window:{PAINEL_MODULES:{}},document:{activeElement:null,getElementById:()=>null},crypto});
  runInContext(readFileSync('painel/public/app.financeiro.entradas.js','utf8'),ctx);
  const app=runInContext('window.PAINEL_MODULES.financeiroEntradas()',ctx);
  return Object.assign(app,{adminUser:{role:'owner'},finHoje:()=> '2026-11-11',businessFactInstant:(date:string)=>date+'T12:00:00-03:00',
    $nextTick:(callback:()=>void)=>callback(),apiPost:vi.fn().mockResolvedValue({id:'saved'}),loadFinanceiro:vi.fn(),loadFinExtrato:vi.fn()});
}
describe('formulário Nova entrada',()=>{
  it('envia valor brasileiro e mantém o mesmo identificador em reenvio após falha',async()=>{
    const app=ui();app.finEntradaAbrir();Object.assign(app.finEntrada,{amount:'1.234,56',description:'Serviço recebido'});
    const key=app.finEntrada.key;app.apiPost.mockRejectedValueOnce(new Error('network'));
    await app.finEntradaSalvar();expect(app.finEntrada.open).toBe(true);await app.finEntradaSalvar();
    expect(app.apiPost.mock.calls[0][1]).toEqual(app.apiPost.mock.calls[1][1]);
    expect(app.apiPost.mock.calls[1][1]).toMatchObject({amount:1234.56,idempotency_key:key,kind:'income',category:'servicos'});
    expect(app.finEntrada.open).toBe(false);expect(app.loadFinanceiro).toHaveBeenCalled();
  });
  it.each(['150,123','1abc','-10','0','1.23.45'])('não arredonda nem limpa silenciosamente valor inválido %s',async amount=>{
    const app=ui();app.finEntradaAbrir();Object.assign(app.finEntrada,{amount,description:'Descrição válida'});
    await app.finEntradaSalvar();expect(app.apiPost).not.toHaveBeenCalled();
  });
  it('aporte não envia categoria de receita e informa que não aumenta lucro',async()=>{
    const app=ui();app.finEntradaAbrir();Object.assign(app.finEntrada,{amount:'500,00',description:'Capital próprio',kind:'owner_contribution'});
    await app.finEntradaSalvar();expect(app.apiPost.mock.calls[0][1]).not.toHaveProperty('category');
    expect(app.finEntradaAviso).toContain('sem aumentar o resultado');
  });
  it('colaborador não abre nem grava entrada',async()=>{
    const app=ui();app.adminUser.role='admin';app.finEntradaAbrir();await app.finEntradaSalvar();
    expect(app.finEntrada.open).toBe(false);expect(app.apiPost).not.toHaveBeenCalled();
  });
});
