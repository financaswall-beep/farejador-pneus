import { describe,it,expect,vi } from 'vitest';
import Fastify from 'fastify';
const state=vi.hoisted(()=>({load:vi.fn(),allow:true}));
vi.mock('../../../src/admin/painel/financial-report-data.js',()=>({readFinancialSnapshot:state.load}));
vi.mock('../../../src/admin/auth.js',()=>({requireAdminAuth:async(_:unknown,reply:any)=>{if(!state.allow)return reply.code(401).send({error:'unauthorized'});}}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test'}}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{}}));
vi.mock('../../../src/shared/logger.js',()=>({logger:{error:vi.fn()}}));
import { financialReportQuery,FinancialReportLimitError } from '../../../src/admin/painel/financial-report-filter.js';
import { buildFinancialReport } from '../../../src/admin/painel/queries-financial-report.js';
import { financialReportCsv } from '../../../src/admin/painel/financial-report-csv.js';
import { registerFinancialReportRoutes } from '../../../src/admin/painel/route-financial-report.js';
import { MatrizCentralLedgerUnavailableError } from '../../../src/admin/painel/queries-financeiro-read-switch.js';
import { requiredMatrixModules } from '../../../src/admin/panel-modules.js';
import type { FinancialSnapshot,FinancialMovement } from '../../../src/admin/painel/financial-report-types.js';

const filter=financialReportQuery.parse({from:'2026-09-01',to:'2026-09-10'});
const movement:FinancialMovement={id:'sale',source_type:'commerce.wholesale_order.revenue',source_id:'sale',description:'Venda a prazo',reference:'ATA-1',party:'Cliente',
  competence_on:'2026-09-02',cash_on:null,category:null,payment_method:null,cash_account:null,reversal_of:null,reversed:false,
  revenue:200,cost:0,expense:0,gain:0,loss:0,cash_in:0,cash_out:0};
const snapshot:FinancialSnapshot={as_of:'2026-09-10T15:00:00Z',today:'2026-09-10',integration_status:'green',opening:[{source_type:'finance.opening',amount:100}],pending_cost:[],
  movements:[movement,{...movement,id:'cost',source_type:'commerce.wholesale_order.cost',revenue:0,cost:80},
    {...movement,id:'payment',source_type:'commerce.wholesale_order.payment',competence_on:'2026-09-05',cash_on:'2026-09-05',revenue:0,cash_in:100,payment_method:'pix'},
    {...movement,id:'expense',source_type:'commerce.matriz_expense.accrual',revenue:0,expense:30,category:'aluguel'},
    {...movement,id:'expense-paid',source_type:'commerce.matriz_expense.payment',revenue:0,cash_out:30,cash_on:'2026-09-06'},
    {...movement,id:'gain',source_type:'finance.inventory_adjustment',revenue:0,gain:10},
    {...movement,id:'loss',source_type:'finance.inventory_adjustment',revenue:0,loss:5}],
  titles:[{id:'title1',source_id:'sale',obligation_id:'sale',side:'receivable',type:'fiado',name:'Cliente',amount:100,due_on:'2026-09-11',category:null,count:1,origin:'atacado'},
    {id:'late',source_id:'late',obligation_id:'late',side:'payable',type:'despesa',name:'Aluguel vencido',amount:20,due_on:'2026-09-09',category:'aluguel',count:1,origin:'despesas'},
    {id:'undated',source_id:'undated',obligation_id:null,side:'payable',type:'marketing',name:'Marketing',amount:50,due_on:null,category:'marketing',count:1,origin:'marketing'}]};

describe('Resultado, caixa e títulos',()=>{
  it('valida datas, limites e filtros sem aceitar ambiente do cliente',()=>{
    for(const invalid of [{environment:'prod'},{from:'2026-02-30'},{from:'2024-01-01'},{to:'2099-01-01'},{cash_day:'2026-09-12'},{horizon:15},{origin:'x'},{view:'x'}])
      expect(financialReportQuery.safeParse({...filter,...invalid}).success).toBe(false);
  });
  it('separa competência, recebimento parcial, saldo anterior e ajustes sem duplicar pernas contábeis',()=>{
    const r=buildFinancialReport(snapshot,filter);
    expect(r.summary).toMatchObject({revenue:200,cost:80,expense:30,inventory_gain:10,inventory_loss:5,result:95,margin:47.5,
      opening:100,incoming:100,outgoing:30,net:70,closing:170,partial:false});
    expect(r.daily.at(-1)?.cumulative).toBe(r.summary.result);expect(r.daily.find(r=>r.day==='2026-09-02')).toMatchObject({result:95,cash_in:0});
    expect(r.cash_rows).toHaveLength(2);expect(r.result_rows).toHaveLength(5);
  });
  it('preserva origem e estorno nas respectivas datas e respeita centavos',()=>{
    const refund={...movement,id:'refund',source_type:'commerce.wholesale_order.refund',competence_on:'2026-09-10',cash_on:'2026-09-10',revenue:0,cash_out:10.01,reversal_of:'payment'};
    const r=buildFinancialReport({...snapshot,movements:[...snapshot.movements,refund]},filter);
    expect(r.summary.closing).toBe(159.99);expect(r.cash_rows.find(r=>r.id==='refund')?.reversal_of).toBe('payment');expect(r.summary.result).toBe(95);
  });
  it('não contabiliza receita com custo pendente como lucro conhecido',()=>{
    const r=buildFinancialReport({...snapshot,pending_cost:[{day:'2026-09-02',amount:50,items:1}]},filter);
    expect(r.summary).toMatchObject({result:45,pending_revenue:50,pending_items:1,partial:true});expect(r.daily.at(-1)?.cumulative).toBe(45);
    expect(buildFinancialReport({...snapshot,integration_status:'yellow'},filter).summary.partial).toBe(true);
  });
  it('filtra a lista por dia/direção sem mudar o período e restringe saldos pela origem',()=>{
    const r=buildFinancialReport(snapshot,{...filter,view:'cash',cash_day:'2026-09-05',direction:'in'});
    expect(r.cash_rows).toHaveLength(1);expect(r.cash_filtered).toEqual({incoming:100,outgoing:0});expect(r.summary.closing).toBe(170);
    expect(buildFinancialReport(snapshot,{...filter,origin:'atacado'}).summary).toMatchObject({opening:0,incoming:100,outgoing:0,result:120});
    expect(buildFinancialReport(snapshot,{...filter,result_kind:'expense'}).result_rows.map(row=>row.id).sort()).toEqual(['expense','loss']);
    expect(buildFinancialReport(snapshot,{...filter,result_kind:'expense',search:'estoque'}).result_rows.map(row=>row.id)).toEqual(['loss']);
  });
  it('agenda mantém posição atual e previsão exclui vencidos e títulos sem vencimento',()=>{
    const r=buildFinancialReport(snapshot,{...filter,view:'cash',flow:'projected',horizon:7});
    expect(r.position).toMatchObject({receivable:100,payable:70,overdue_payable:20,undated_payable:50});
    expect(r.projection).toMatchObject({from:'2026-09-10',to:'2026-09-16',incoming:100,outgoing:0});expect(r.projection.rows).toHaveLength(1);
    expect(buildFinancialReport(snapshot,{...filter,view:'titles',due:'overdue'}).titles.map(r=>r.id)).toEqual(['late']);
    expect(buildFinancialReport(snapshot,{...filter,from:'2026-08-01',to:'2026-08-31'}).position).toEqual(r.position);
  });
  it('não confunde ausência de base com margem zero e representa resultado negativo',()=>{
    const empty=buildFinancialReport({...snapshot,movements:[],opening:[],titles:[]},filter);expect(empty.summary.margin).toBeNull();expect(empty.summary.result).toBe(0);
    const loss=buildFinancialReport({...snapshot,movements:[{...movement,revenue:0,expense:5}]},filter);expect(loss.summary.result).toBe(-5);expect(loss.daily.at(-1)?.cumulative).toBe(-5);
  });
  it('exporta coleção completa, protege fórmulas e não inclui telefone/endereço/metadata',()=>{
    const r=buildFinancialReport({...snapshot,titles:Array.from({length:31},(_,i)=>({...snapshot.titles[0]!,id:String(i),name:'=SUM(1)'}))},{...filter,view:'titles'});
    const csv=financialReportCsv(r);expect(csv.split('\r\n')).toHaveLength(32);expect(csv).toContain("'=SUM(1)");expect(csv).not.toMatch(/phone|telefone|endereço|metadata/);
    expect(financialReportCsv(buildFinancialReport(snapshot,{...filter,view:'cash'}))).toContain('pix');
    expect(financialReportCsv(buildFinancialReport(snapshot,{...filter,view:'result'}))).toContain('Competência');
    expect(financialReportCsv(buildFinancialReport(snapshot,{...filter,view:'titles'}))).toContain('Sem vencimento');
  });
  it('exige Financeiro e distingue desativado, divergência, limite e falha de consulta',async()=>{
    const app=Fastify();await registerFinancialReportRoutes(app);const url='/admin/api/relatorios/financeiro',q='?from=2026-09-01&to=2026-09-10';
    try{for(const suffix of ['','/exportar','/imprimir'])expect(requiredMatrixModules(url+suffix)).toEqual(['financeiro']);
      state.allow=false;expect((await app.inject(url+q)).statusCode).toBe(401);state.allow=true;state.load.mockResolvedValue(snapshot);
      const r=await app.inject(url+q);expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('no-store');
      expect((await app.inject(url+q+'&environment=prod')).statusCode).toBe(400);
      state.load.mockRejectedValueOnce(new MatrizCentralLedgerUnavailableError('integration_red'));expect((await app.inject(url+q)).statusCode).toBe(409);
      state.load.mockRejectedValueOnce(new FinancialReportLimitError());expect((await app.inject(url+q)).statusCode).toBe(422);
      state.load.mockRejectedValueOnce(Error('offline'));expect((await app.inject(url+q)).statusCode).toBe(503);
    }finally{await app.close();vi.clearAllMocks();}
  });
});
