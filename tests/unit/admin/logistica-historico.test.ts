import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
function app() {
  const ctx=vm.createContext({window:{},Date,Intl,URLSearchParams,console});
  for(const name of ['logistica','logistica.resultado','logistica.comprovantes','logistica.historico']) vm.runInContext(readFileSync(`painel/public/app.${name}.js`,'utf8'),ctx);
  const s:any={logistica:{rotas_abertas:[],rotas_recentes:[],receipt_approval:true},logisticaTab:'historico',adminUser:{role:'owner'},$nextTick:(fn:()=>void)=>fn(),$refs:{receiptReviewDetails:{open:false,scrollIntoView:vi.fn()},logHistEntregasDialog:{showModal:vi.fn()}}};
  for(const factory of Object.values(ctx.window.PAINEL_MODULES) as (()=>object)[]) Object.assign(s,factory());
  s.logHistFiltros.from='2024-01-01';s.logHistFiltros.to='2024-01-31';s.loadReceiptThumbs=vi.fn();
  return s;
}
const row={id:'old-trip',trip_number:'202',status:'closed',ended_at:'2024-01-02T01:00:00Z',courier_name:'Entregador',financial_status:'pending',resumo:{entregues:1,frete_total:0,lucro_pneus:100,faturamento_total:200,custo_pneus:100},despesas_total:20,receipts:[{id:'receipt',workflow_status:'review_required'}]};
const page=(rows=[row],n=1,total=rows.length)=>({rows,page:n,couriers:[],summary:{closed:total,reconciled:0,pending:total,result:'0'},as_of:'2026-09-17T12:00:00Z'});
describe('Histórico — consulta, seleção e composição',()=>{
  it('consulta o período antigo com busca codificada e preserva a seleção ao atualizar',async()=>{
    const s=app();s.logHistFiltros.q='José & #202';s.logHistPagina=2;s.logisticaRotaSelecionadaId=row.id;s.apiGet=vi.fn().mockResolvedValue(page([row],2,7));
    await s.logHistCarregar();const url=new URL(s.apiGet.mock.calls[0][0],'http://localhost');
    expect(url.searchParams.get('q')).toBe('José & #202');expect(url.searchParams.get('page')).toBe('2');expect(url.searchParams.get('from')).toBe('2024-01-01');
    expect(s.logisticaRotaSelecionada()).toEqual(row);expect(s.logHistPaginas()).toBe(2);
    s.apiGet.mockResolvedValue(page([]));await s.logHistFiltrar();expect(s.logisticaRotaSelecionada()).toBeNull();expect(s.logHistPagina).toBe(1);
  });
  it('ignora resposta antiga quando um novo filtro já foi aplicado',async()=>{
    const s=app();let first:any;s.apiGet=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{first=resolve;})).mockResolvedValue(page([{...row,id:'new'}]));
    const old=s.logHistCarregar();await s.logHistFiltrar();first(page());await old;expect(s.logisticaRotaSelecionadaId).toBe('new');expect(s.logHistCarregando).toBe(false);
  });
  it('preserva dados em falha de atualização e impede abrir revisão com dados desatualizados',async()=>{
    const s=app();s.logHistDados=page();s.logisticaRotaSelecionadaId=row.id;s.apiGet=vi.fn().mockRejectedValue(new Error('offline'));
    await s.logHistCarregar();s.logHistRevisar();expect(s.logHistDados.rows).toHaveLength(1);expect(s.logHistErro).toContain('anteriores');expect(s.$refs.receiptReviewDetails.open).toBe(false);
    s.logHistFiltros.from='2025-01-01';await s.logHistCarregar();expect(s.apiGet).toHaveBeenCalledTimes(1);expect(s.logHistErro).toContain('período válido');
  });
  it('abre uma rota da operação na data de São Paulo, mesmo fora do período atual',async()=>{
    const s=app();s.apiGet=vi.fn().mockResolvedValue(page());await s.abrirResultadoRota(row);
    expect(s.logisticaTab).toBe('historico');expect(s.logHistFiltros).toMatchObject({from:'2024-01-01',to:'2024-01-01',q:'202'});expect(s.logisticaRotaSelecionadaId).toBe(row.id);
  });
  it('mantém resultado negativo e explicita margem não apurada, sem contar comprovante pendente',()=>{
    const s=app();expect(s.rotaResultado(row).resultado).toBe(80);expect(s.rotaResultado(row).completo).toBe(false);
    const unknown={...row,resumo:{...row.resumo,lucro_pneus:0,custo_pneus:0,itens_sem_custo:1}};s.logHistDados=page([unknown]);s.logisticaRotaSelecionadaId=row.id;
    expect(s.rotaResultado(unknown).resultado).toBe(-20);expect(s.logHistMargemNaoApurada()).toBe(200);
  });
  it('revisa só a rota selecionada sem duplicar recibos e mantém fila da operação independente',()=>{
    const s=app();s.logHistDados=page();s.logisticaRotaSelecionadaId=row.id;s.logistica.rotas_recentes=[row,{...row,id:'other',receipts:[{id:'other-receipt',workflow_status:'review_required'}]}];
    s.logHistRevisar();expect(s.receiptReviewQueue().map((q:any)=>q.receipt.id)).toEqual(['receipt']);expect(s.$refs.receiptReviewDetails.open).toBe(true);
    s.logisticaTab='visao';s.logHistDados.rows=[{...row,receipts:[]}];expect(s.receiptReviewQueue()).toHaveLength(2);
    s.logisticaTab='historico';s.adminUser.role='admin';s.$refs.receiptReviewDetails.open=false;s.logHistRevisar();expect(s.$refs.receiptReviewDetails.open).toBe(false);expect(s.logHistDetalhe).toBe(true);
  });
  it('não repõe entregas após fechar a janela e preserva o rótulo de tentativa anterior',async()=>{
    const s=app();s.logHistDados=page();s.logisticaRotaSelecionadaId=row.id;let resolve:any;s.apiGet=()=>new Promise(r=>{resolve=r;});
    const pending=s.logHistVerEntregas();s.logHistEntregasId=null;resolve({rows:[{id:'1'}]});await pending;
    expect(s.logHistEntregas).toHaveLength(0);expect(s.logHistEntregaLabel({historical:true,status:'delivered'})).toBe('Tentativa não entregue');
  });
});
