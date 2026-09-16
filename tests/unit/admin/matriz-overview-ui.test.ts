import fs from 'node:fs';
import vm from 'node:vm';
import {describe,it,expect,vi} from 'vitest';
function fixture(){
  const window:any={PAINEL_MODULES:{},lucide:{createIcons:vi.fn()}};
  vm.runInNewContext(fs.readFileSync('painel/public/app.resumo.js','utf8'),{window,Intl,Date,URLSearchParams});
  return Object.assign(window.PAINEL_MODULES.resumo(),{adminAuthenticated:true,isMatrixPanel:()=>true,hasPanelModule:()=>true,
    $nextTick:(f:()=>void)=>f(),renderOverviewChart:vi.fn(),apiGet:vi.fn(),panelPageEnabled:()=>true});
}
const payload=(revenue=100)=>({period:{from:'2026-09-01',to:'2026-09-16',month:'2026-09'},sales:{summary:{revenue},daily:[]},updated_at:'2026-09-16T10:00:00Z'});
describe('Resumo: filtros e falhas de consulta',()=>{
  it('descarta resposta antiga quando o período muda durante a consulta',async()=>{
    const ui=fixture();let first:any,second:any;
    ui.apiGet.mockImplementationOnce(()=>new Promise(resolve=>{first=resolve;})).mockImplementationOnce(()=>new Promise(resolve=>{second=resolve;}));
    const a=ui.loadMatrizOverview();ui.overviewPeriod='today';const b=ui.loadMatrizOverview();
    second(payload(200));await b;first(payload(100));await a;
    expect(ui.overview.sales.summary.revenue).toBe(200);expect(ui.overviewLoading).toBe(false);
    expect(ui.apiGet.mock.calls[1][0]).toContain('period=today');
  });
  it('mantém última leitura e mostra erro; filtro novo limpa valores antigos',async()=>{
    const ui=fixture();ui.overview=payload();ui.apiGet.mockRejectedValue(Error('offline'));
    await ui.loadMatrizOverview();expect(ui.overview.sales.summary.revenue).toBe(100);expect(ui.overviewError).toContain('última consulta');
    ui.overviewSetPeriod('7d');expect(ui.overview).toBeNull();await Promise.resolve();
  });
  it('não apresenta lucro confirmado quando há custo pendente ou divergência',()=>{
    const ui=fixture();ui.overview={finance:{status:'custo_pendente',result_cents:500}};
    expect(ui.overviewResult()).toBe('Em conferência');expect(ui.overviewResultDetail()).toContain('custo pendente');
    ui.overview.finance.status='divergente';expect(ui.overviewResult()).toBe('Em conferência');
    ui.overview.finance.status='confirmado';expect(ui.overviewResult()).toContain('5,00');
  });
  it('atalhos respeitam permissões e compras abre o formulário existente',()=>{
    const ui=fixture();ui.overviewGo('compras','nova');expect(ui.currentPage).toBe('compras');expect(ui.comprasTab).toBe('nova');
    ui.panelPageEnabled=()=>false;ui.overviewGo('financeiro');expect(ui.currentPage).toBe('compras');
  });
});
