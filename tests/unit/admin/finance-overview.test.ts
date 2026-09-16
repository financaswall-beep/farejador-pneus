import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
function context() {
  const sandbox: any = { window: { PAINEL_MODULES: {} }, console, URLSearchParams };
  for (const name of ['visao', 'visao.chart', 'indicadores', 'baixas']) vm.runInNewContext(readFileSync(`painel/public/app.financeiro.${name}.js`, 'utf8'), sandbox);
  const s: any = Object.assign({}, ...Object.values(sandbox.window.PAINEL_MODULES).map((f: any) => f()));
  return Object.assign(s, {
    finMes: '2026-09', finHoje: () => '2026-09-15',
    financeiroVisao: { verdade: { caixa: { saldo_atual: '1000' }, competencia: { lucro_confirmado: '0', receita_custo_conhecido: '0', receita_custo_pendente: '0' } }, a_receber: { itens: [] }, a_pagar: { itens: [] } },
    pagarOrigem: () => 'Despesa', cobrancaOrigem: () => 'Venda',
    cobrancaDias: (v: string) => v ? Math.round((Date.parse(v+'T00:00:00Z') - Date.parse('2026-09-15T00:00:00Z')) / 86400000) : null,
  });
}
describe('visão financeira com previsão por vencimento', () => {
  it('separa atrasados e sem data, inclui hoje e atravessa o mês com valores em centavos', () => {
    const s = context();
    s.financeiroVisao.a_receber.itens = [
      { id:'old',due_date:'2026-09-14',valor:'900' }, { id:'today',due_date:'2026-09-15',valor:'.10' },
      { id:'last',due_date:'2026-09-22',valor:'.20' }, { id:'late',due_date:'2026-09-23',valor:'100' },
      { id:'unknown',due_date:null,valor:'700' }, { id:'next',due_date:'2026-10-01',valor:'20' },
    ];
    s.financeiroVisao.a_pagar.itens = [{ due_date:'2026-09-17',valor:'100' }];
    expect(s.finVisaoFluxo()).toMatchObject({ incoming:.3,outgoing:100,projected:900.3,overdueIncoming:900,undated:1 });
    s.finAgendaFiltro='saida'; expect(s.finVisaoAgenda()).toHaveLength(1);
    s.finVisaoDias=30; expect(s.finVisaoFluxo().incoming).toBe(120.3);
  });
  it('não chama zero de positivo nem custo desconhecido de margem confirmada', () => {
    const s=context(); expect(s.finVisaoResumo().margin).toBe('Resultado zerado');
    Object.assign(s.financeiroVisao.verdade.competencia,{lucro_confirmado:'-20',receita_custo_conhecido:'100'});
    expect(s.finVisaoResumo()).toMatchObject({result:-20,margin:'-20% de margem'});
    s.financeiroVisao.verdade.competencia.receita_custo_pendente='80';
    expect(s.finVisaoResumo()).toMatchObject({missing:true,title:'Resultado parcial do mês',margin:'Há vendas com custo pendente'});
  });
  it('gráfico aceita saldo negativo e não fabrica previsão em mês anterior', () => {
    const s=context(); s.finMes='2026-08';
    s.finOverview={period:'2026-08',through:'2026-08-31',opening:'0',days:[{date:'2026-08-31',incoming:'0',outgoing:'72'}]};
    expect(s.finVisaoChart()).toContain('72,00'); expect(s.finVisaoChart()).not.toMatch(/NaN|Infinity|PREVISÃO/);
    s.finMes='2026-09'; expect(s.finVisaoChart()).toBe('');
    s.finOverview={period:'2026-09',through:'2026-09-15',opening:'0',days:[{date:'2026-09-15',incoming:'0',outgoing:'0'}]};
    expect(s.finVisaoChart()).toContain('PREVISÃO · 7 DIAS'); expect(s.finVisaoChart()).not.toMatch(/NaN|Infinity/);
  });
  it('resposta atrasada não substitui a nova seleção', async () => {
    const s=context(); let first:any;
    s.apiGet=vi.fn().mockImplementationOnce(()=>new Promise(r=>{first=r;})).mockResolvedValueOnce({period:'2026-08'});
    const old=s.loadFinOverview(); s.finMes='2026-08'; await s.loadFinOverview(); first({period:'2026-09'}); await old;
    expect(s.finOverview.period).toBe('2026-08');
  });
});
