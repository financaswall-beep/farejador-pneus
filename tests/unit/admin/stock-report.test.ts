import Fastify from 'fastify';
import { describe,it,expect,vi } from 'vitest';
const db=vi.hoisted(()=>({query:vi.fn(),release:vi.fn(),connect:vi.fn()}));
const auth=vi.hoisted(()=>({allow:true}));
vi.mock('../../../src/persistence/db.js',()=>({pool:db}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test'}}));
vi.mock('../../../src/shared/logger.js',()=>({logger:{error:vi.fn()}}));
vi.mock('../../../src/admin/auth.js',()=>({getAdminContext:()=>({role:'admin',modules:['estoque']}),
  requireAdminAuth:async(_:unknown,reply:{code:(n:number)=>{send:(v:unknown)=>unknown}})=>{if(!auth.allow)return reply.code(401).send({error:'unauthorized'});}}));
import { buildStockReport } from '../../../src/admin/painel/queries-stock-report.js';
import { stockReportQuery } from '../../../src/admin/painel/stock-report-filter.js';
import { stockReportCsv } from '../../../src/admin/painel/stock-report-csv.js';
import { readStockReportSnapshot } from '../../../src/admin/painel/stock-report-data.js';
import { registerStockReportRoutes } from '../../../src/admin/painel/route-stock-report.js';
import { requiredMatrixModules } from '../../../src/admin/panel-modules.js';
import type { StockReportSnapshot,StockReportVariant,StockReportMovement } from '../../../src/admin/painel/stock-report-data.js';
const filter=stockReportQuery.parse({}),variant:StockReportVariant={measure:'130/70-13',brand:'Pirelli',condition:'novo',physical:4,reserved:1,incoming:0,minimum:20,has_stock:true};
const event:StockReportMovement={id:'event',measure:'130/70-13',brand:'Pirelli',condition:'novo',at:'2026-09-10T12:00:00.000Z',before:28,after:4,delta:-24,source:'varejo'};
const snapshot:StockReportSnapshot={as_of:'2026-09-10T13:00:00.000Z',from:'2026-08-12',to:'2026-09-10',
  variants:[variant,{...variant,brand:'Michelin',physical:1,reserved:0},{...variant,brand:'Technic',physical:0,reserved:0,incoming:8,has_stock:false}],movements:[event]};

describe('estoque e reposição: regras do relatório',()=>{
  it('rejeita ambiente, base inválida, paginação negativa e filtros desconhecidos',()=>{
    for(const extra of [{environment:'prod'},{days:'7'},{offset:-1},{condition:'usado'},{status:'bad'},{view:'abc'},{source:'varejo'}])expect(stockReportQuery.safeParse(extra).success).toBe(false);
  });
  it('não duplica o mínimo entre marcas, desconta reservas uma vez e inclui marca somente em trânsito',()=>{
    const report=buildStockReport(snapshot,filter),row=report.groups[0]!;
    expect(row).toMatchObject({physical:5,reserved:1,available:4,incoming:8,minimum:20,suggested:8,sold:24,coverage_days:5,status:'replenish'});
    expect(report.summary).toMatchObject({available:4,reserved:1,incoming:8,replenish:1,suggested:8});
  });
  it('separa condições, mínimo zero e mínimo ausente; cobertura sem giro fica indefinida',()=>{
    const report=buildStockReport({...snapshot,variants:[...snapshot.variants,{...variant,condition:'meia_vida',minimum:0},
      {...variant,measure:'90/90-12',physical:0,reserved:0,minimum:null}],movements:[]},filter);
    expect(report.groups.find(row=>row.condition==='meia_vida')).toMatchObject({minimum:0,suggested:0,coverage_days:null});
    expect(report.groups.find(row=>row.measure==='90/90-12')).toMatchObject({minimum:null,suggested:null,status:'zero'});
    expect(report.summary.no_minimum).toBe(1);
  });
  it('não sugere recompra quando o trânsito cobre o mínimo, mesmo sem disponível',()=>{
    const report=buildStockReport({...snapshot,variants:[{...variant,physical:0,reserved:0,incoming:25}]},filter);
    expect(report.groups[0]).toMatchObject({available:0,suggested:0,status:'zero',coverage_days:0});expect(report.summary.replenish).toBe(0);
    expect(buildStockReport({...snapshot,variants:[{...variant,incoming:20}]},filter).groups[0]?.status).toBe('incoming');
  });
  it('giro inclui devoluções e marcas removidas, sem confundir ajustes com vendas',()=>{
    const report=buildStockReport({...snapshot,movements:[event,{...event,id:'return',source:'cancelamento_varejo',delta:4},
      {...event,id:'old-brand',brand:'Levorin',delta:-10},{...event,id:'adjustment',source:'baixa_manual',delta:-100}]},filter);
    expect(report.groups[0]?.sold).toBe(30);
    expect(report.groups[0]?.brands.find(row=>row.brand==='Levorin')).toMatchObject({available:0,sold:10,has_stock:false});
    expect(report.movement_summary).toMatchObject({total:4,in:4,out:134});
  });
  it('filtros de movimentos não alteram estoque ou giro; situação atual restringe a trilha quando solicitada',()=>{
    const filtered=buildStockReport({...snapshot,movements:[event,{...event,id:'return',source:'cancelamento_varejo',delta:2}]},{...filter,source:'return',movement:'in'});
    expect(filtered.groups[0]?.sold).toBe(22);expect(filtered.movements.total).toBe(1);expect(filtered.summary.available).toBe(4);
    expect(buildStockReport(snapshot,{...filter,status:'healthy'}).movements.total).toBe(0);
    expect(buildStockReport(snapshot,{...filter,condition:'meia_vida'}).summary.groups).toBe(0);
    expect(buildStockReport(snapshot,{...filter,measure:'130/70',exact:'true'}).summary.groups).toBe(0);
  });
  it('paginação não corta exportação e CSV protege texto interpretável como fórmula',()=>{
    const data={...snapshot,movements:Array.from({length:31},(_,i)=>({...event,id:'event-'+i,brand:'=SUM(1)'}))};
    const report=buildStockReport(data,{...filter,view:'movements',offset:25});
    expect(report.movements.rows).toHaveLength(6);expect(report.export_movements).toHaveLength(31);
    const csv=stockReportCsv(report);expect(csv.split('\r\n')).toHaveLength(32);expect(csv).toContain("'=SUM(1)");
    expect(stockReportCsv(buildStockReport(snapshot,{...filter,view:'replenishment'})).split('\r\n')).toHaveLength(2);
  });
});

describe('estoque: consulta, acesso e erros',()=>{
  const clock={as_of:new Date(snapshot.as_of),from:snapshot.from,to:snapshot.to};
  const setup=()=>{db.connect.mockResolvedValue(db);db.query.mockImplementation(async(sql:string)=>{
    if(sql.includes('SELECT now()'))return{rows:[clock]};if(sql.startsWith('WITH pending'))return{rows:snapshot.variants};
    if(sql.includes('FROM commerce.wholesale_stock_movements'))return{rows:[{...event,at:new Date(event.at)}]};return{rows:[]};});};
  it('lê um snapshot somente leitura, libera conexão e não busca notas, preços ou contatos',async()=>{
    setup();try{const result=await readStockReportSnapshot(db as never,'test',filter);
      expect(result).toEqual(snapshot);expect(db.query.mock.calls[0]?.[0]).toContain('REPEATABLE READ READ ONLY');
      const sql=db.query.mock.calls.map(call=>call[0]).join('\n');expect(sql).not.toMatch(/cost_|reason|phone|document/);
      expect(db.query.mock.calls.find(call=>call[0].startsWith('WITH pending'))?.[1]).toEqual(['test']);expect(db.release).toHaveBeenCalled();
    }finally{vi.clearAllMocks();}
  });
  it('exige Estoque nas três rotas, valida filtros e distingue erro de consulta de vazio',async()=>{
    const app=Fastify();await registerStockReportRoutes(app);setup();
    try{
      for(const suffix of ['','/exportar','/imprimir'])expect(requiredMatrixModules('/admin/api/relatorios/estoque'+suffix)).toEqual(['estoque']);
      auth.allow=false;expect((await app.inject('/admin/api/relatorios/estoque')).statusCode).toBe(401);auth.allow=true;
      expect((await app.inject('/admin/api/relatorios/estoque?environment=prod')).statusCode).toBe(400);
      const response=await app.inject('/admin/api/relatorios/estoque');expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');expect(response.json()).not.toHaveProperty('export_movements');
      expect((await app.inject('/admin/api/relatorios/estoque/exportar')).body).toContain('Reposição sugerida');
      db.query.mockRejectedValueOnce(new Error('offline'));expect((await app.inject('/admin/api/relatorios/estoque')).statusCode).toBe(503);
    }finally{vi.clearAllMocks();await app.close();}
  });
  it('não trunca excesso de movimentos e encerra a transação com rollback',async()=>{
    setup();db.query.mockImplementation(async(sql:string)=>{
      if(sql.includes('SELECT now()'))return{rows:[clock]};if(sql.includes('FROM commerce.wholesale_stock_movements'))return{rows:Array(50001).fill(event)};return{rows:[]};
    });
    try{await expect(readStockReportSnapshot(db as never,'test',filter)).rejects.toThrow('stock_report_movement_limit');
      expect(db.query).toHaveBeenCalledWith('ROLLBACK');expect(db.release).toHaveBeenCalled();
    }finally{vi.clearAllMocks();}
  });
});
