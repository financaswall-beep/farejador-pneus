import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
const database = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: database }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { error: vi.fn() } }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/shared/business-time.js', () => ({ businessDateSaoPaulo: () => '2026-09-10' }));
import { salesReportQuery, salesReportComparison } from '../../../src/admin/painel/sales-report-period.js';
import { buildSalesReport } from '../../../src/admin/painel/queries-sales-report.js';
import { requiredMatrixModules } from '../../../src/admin/panel-modules.js';
import type { ReportLine } from '../../../src/admin/painel/sales-report-data.js';
const auth = vi.hoisted(() => ({ allow: true, costs: false, finance: false }));
vi.mock('../../../src/admin/auth.js', () => ({
  requireAdminAuth: async (_request: unknown, reply: {code:(status:number)=>{send:(v:unknown)=>unknown}}) => {
    if (!auth.allow) return reply.code(401).send({ error:'unauthorized' });
  },
  getAdminContext: () => ({ role: auth.costs ? 'owner' : 'admin', modules:auth.finance?['vendas','financeiro']:['vendas'] }),
}));
import { registerSalesReportRoutes, salesReportCsvCell } from '../../../src/admin/painel/route-sales-report.js';
const filter = salesReportQuery.parse({from:'2026-09-01',to:'2026-09-10'});
const row: ReportLine = { id:'line',sale_id:'sale',channel:'varejo',day:'2026-09-01',measure:'90/90-12',brand:'Pirelli',condition:'novo',kind:'tire',quantity:2,revenue:19000,cost:12000 };

describe('relatório de vendas: filtros, comparação e matemática', () => {
  it('rejeita datas falsas, futuro, intervalo invertido, ambiente e filtros desconhecidos', () => {
    for (const value of [{from:'2026-02-30',to:'2026-03-01'},{to:'2026-09-11'},{from:'2026-09-10',to:'2026-09-01'},
      {environment:'prod'},{channel:'parceiro'},{condition:'usado'},{from:'2024-01-01'}]) {
      expect(salesReportQuery.safeParse({...filter,...value}).success).toBe(false);
    }
  });
  it('compara os mesmos dias no mês, incluindo fevereiro, e intervalos contíguos na semana', () => {
    expect(salesReportComparison(filter)).toEqual({from:'2026-08-01',to:'2026-08-10'});
    expect(salesReportComparison({...filter,from:'2026-03-01',to:'2026-03-31'})).toEqual({from:'2026-02-01',to:'2026-02-28'});
    expect(salesReportComparison({...filter,from:'2026-01-01',to:'2026-01-10'})).toEqual({from:'2025-12-01',to:'2025-12-10'});
    expect(salesReportComparison({...filter,mode:'week',from:'2026-09-07',to:'2026-09-10'})).toEqual({from:'2026-09-03',to:'2026-09-06'});
    expect(salesReportComparison({...filter,compare:'false'})).toBeNull();
  });
  it('não duplica pedidos; separa serviços, custos pendentes e histórico comparado', () => {
    const report=buildSalesReport([row,{...row,id:'service',kind:'service',measure:'Montagem',quantity:1,revenue:3000,cost:500},
      {...row,id:'unknown',sale_id:'second',brand:'Michelin',measure:'130/70-13',quantity:1,revenue:20000,cost:null},
      {...row,id:'previous',sale_id:'previous',day:'2026-08-01',revenue:15000}],filter,true);
    expect(report.summary).toMatchObject({orders:2,tires:3,units:4,revenue:420,ticket:210,cost:null,margin:null,known_margin:95,pending_cost_lines:1});
    expect(report.previous?.revenue).toBe(150);expect(report.daily[0]).toMatchObject({revenue:420,previous:150});
    expect(report.measures.find(item=>item.measure==='90/90-12')).toMatchObject({margin:70,cost:120});
  });
  it('filtra marca e medida exata sem incluir uma medida que apenas contém o texto', () => {
    const report=buildSalesReport([row,{...row,id:'other',measure:'190/90-12',brand:'Michelin'}],{...filter,measure:'90/90-12',exact:'true'},false);
    expect(report.summary.revenue).toBe(190);expect(report.summary.margin).toBeNull();
    expect(report.export_sales[0].items[0].cost).toBeNull();expect(report.summary.known_cost).toBeNull();
    expect(report.brands).toEqual(['Michelin','Pirelli']);
    expect(buildSalesReport([row],{...filter,brand:'Michelin'},true).summary.orders).toBe(0);
  });
  it('expõe somente rotas autenticadas e associa o relatório à permissão de Vendas', async () => {
    expect(requiredMatrixModules('/admin/api/relatorios/vendas/exportar?from=x')).toEqual(['vendas']);
    const app=Fastify();await registerSalesReportRoutes(app);auth.allow=false;
    try {for(const path of ['','/exportar','/imprimir'])expect((await app.inject('/admin/api/relatorios/vendas'+path)).statusCode).toBe(401);
      auth.allow=true;expect((await app.inject('/admin/api/relatorios/vendas?from=2026-02-31&to=2026-03-01')).statusCode).toBe(400);
    } finally {auth.allow=true;await app.close();}
  });
  it('exporta texto literal sem fórmulas de planilha', () => {
    expect(salesReportCsvCell(' =HYPERLINK("x")')).toBe('"\' =HYPERLINK(""x"")"');
    expect(salesReportCsvCell('Meia-vida')).toBe('"Meia-vida"');
  });
  it('entrega página de vendas e exporta o recorte inteiro sem revelar custos a Vendas', async () => {
    database.query.mockResolvedValue({rows:Array.from({length:30},(_,i)=>({...row,id:'line'+i,sale_id:'sale'+i,revenue:'190',cost:'120'}))});
    const app=Fastify();await registerSalesReportRoutes(app);
    const url='/admin/api/relatorios/vendas',query='?from=2026-09-01&to=2026-09-10&offset=25';
    try {
      const response=await app.inject(url+query),payload=response.json();
      expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
      expect(payload.sales.rows).toHaveLength(5);expect(payload.sales.total).toBe(30);
      expect(payload.export_sales).toBeUndefined();expect(payload.summary.margin).toBeNull();
      expect(payload.sales.rows.every((sale:{items:{cost:null}[]})=>sale.items[0].cost===null)).toBe(true);
      const csv=await app.inject(url+'/exportar'+query);
      expect(csv.statusCode).toBe(200);expect(csv.body.split('\r\n')).toHaveLength(31);
      expect(csv.body).not.toContain('Custo histórico');expect(csv.body).not.toContain('Margem bruta');
      const print=await app.inject(url+'/imprimir'+query);
      expect(print.json().sales.rows).toHaveLength(30);
      auth.finance=true;
      const finance=await app.inject(url+query);
      expect(finance.json().summary).toMatchObject({cost:3600,margin:2100});
      expect((await app.inject(url+'/exportar'+query)).body).toContain('Custo histórico');
    } finally {auth.finance=false;database.query.mockReset();await app.close();}
  });
  it('explica limite excedido e falha de consulta sem devolver um relatório zerado', async () => {
    const app=Fastify();await registerSalesReportRoutes(app);
    try {
      database.query.mockResolvedValueOnce({rows:Array(50001).fill(row)});
      const limit=await app.inject('/admin/api/relatorios/vendas?from=2026-09-01&to=2026-09-10');
      expect(limit.statusCode).toBe(422);expect(limit.json().error).toBe('report_limit_reduce_period');
      database.query.mockRejectedValueOnce(new Error('database unavailable'));
      const failed=await app.inject('/admin/api/relatorios/vendas?from=2026-09-01&to=2026-09-10');
      expect(failed.statusCode).toBe(503);expect(failed.json()).toEqual({error:'sales_report_unavailable'});
    }finally{database.query.mockReset();await app.close();}
  });
});
