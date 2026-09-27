import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { organicPublicationWindow } from '../../../src/admin/painel/marketing-organic-period.js';

function summary() {
  const context = vm.createContext({window:{PAINEL_MODULES:{}}, Date, Intl});
  for (const name of ['organic','organic.summary','organic.mock']) {
    vm.runInContext(readFileSync(`painel/public/app.marketing.${name}.js`, 'utf8'), context);
  }
  const state = Object.assign(context.window.PAINEL_MODULES.marketingOrganic(),context.window.PAINEL_MODULES.marketingOrganicSummary(),{
    marketingIsMock:()=>true,
  });
  state.moSelected = {id:'123',platform:'instagram',title:'Pneu para NMAX',caption:'130/70-13',published_at:'2026-09-12T12:00:00Z'};
  state.moDetail = context.marketingOrganicMockDetail(state.moSelected);
  return state;
}

describe('Resumo comercial de uma publicação', () => {
  it('mantém ausência de atribuição distinta de zero e recusa valores de outra janela', () => {
    const a = summary(); a.moDetail.attribution.status = 'not_implemented';
    expect(a.moSummaryCards().every((k:any)=>k.value===null)).toBe(true);
    expect(a.moSalesSeries()).toEqual([]); expect(a.moConversionPercent()).toBe('—');
    a.moDetail.attribution.status = 'ready'; a.moDetail.attribution.sales=0;
    expect(a.moSummaryValue('sales')).toBe(0);
    a.moSummaryPeriod = '30d';
    expect(a.moSummaryValue('sales')).toBeNull(); expect(a.moSalesSeries()).toEqual([]);
  });
  it('conta conversas convertidas, sem dividir pedidos repetidos pelo número de conversas', () => {
    const a=summary(); a.moDetail.attribution.sales=12;
    expect(a.moConversionPercent()).toBe('26,7%');
    expect(a.moConversionText()).toBe('8 de 30 conversas viraram venda');
    for (const count of [null,31,-1,'8']) {
      a.moDetail.attribution.converted_conversations=count; expect(a.moConversion()).toBeNull();
    }
    a.moDetail.attribution.conversations=0; a.moDetail.attribution.converted_conversations=0;
    expect(a.moConversion()).toBeNull();
  });
  it('não desenha série com datas duplicadas, fora da janela, valores inválidos ou acumulado decrescente', () => {
    const a=summary(); expect(a.moSalesSeries()).toHaveLength(7);
    for (const rows of [
      [{date:'2026-09-12',sales:3},{date:'2026-09-13',sales:2}],
      [{date:'2026-09-12',sales:1},{date:'2026-09-12',sales:2}],
      [{date:'2026-09-12',sales:1},{date:'2026-09-19',sales:2}],
      [{date:'2026-09-12',sales:null}], [null], [{date:'2026-09-12',sales:1.5}],
    ]) {a.moDetail.attribution.sales_series=rows; expect(a.moSalesSeries()).toEqual([]);}
  });
  it('exporta o período e a origem sem converter dados pendentes em zero; neutraliza fórmulas', () => {
    const a=summary(); a.moSelected.title='=HYPERLINK("teste")'; a.moDetail.attribution.status='not_implemented';
    const csv=a.moSummaryCsv();
    expect(csv).toContain('"\'=HYPERLINK(""teste"")"');
    expect(csv).toContain('"Vendas concluídas";"Indisponível"');
    expect(csv).toContain('"Origem";"Vínculo pendente"');
    expect(csv).toContain('"Dados";"Ilustrativos"');
    expect(csv).toContain('"Início";"2026-09-12"');
    expect(csv).toContain('"Fim";"2026-09-18"');
  });
  it('usa a data do post e uma faixa compacta para os primeiros sete dias', () => {
    const a=summary(); expect(a.moSummaryRange()).toBe('12 a 18 set. 2026');
    expect(a.moPostContext()).toBe('130/70-13 · Instagram');
  });
});

describe('Janela de publicação em São Paulo', () => {
  it('inclui o dia inicial sem deslocar o período na virada UTC', () => {
    expect(organicPublicationWindow('2026-10-01T01:00:00Z','7d')).toEqual({id:'7d',since:'2026-09-30',until:'2026-10-06',timezone:'America/Sao_Paulo'});
  });
  it('trata a virada do ano e meses de durações diferentes', () => {
    expect(organicPublicationWindow('2026-12-31T12:00:00Z','30d').until).toBe('2027-01-29');
    expect(organicPublicationWindow('2028-02-27T12:00:00Z','7d').until).toBe('2028-03-04');
  });
});
