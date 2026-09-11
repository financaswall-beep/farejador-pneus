import { describe,it,expect,vi } from 'vitest';
import Fastify from 'fastify';
const state=vi.hoisted(()=>({load:vi.fn(),allow:true}));
vi.mock('../../../src/admin/painel/demand-report-data.js',()=>({readDemandSnapshot:state.load}));
vi.mock('../../../src/admin/auth.js',()=>({requireAdminAuth:async(_:unknown,reply:any)=>{if(!state.allow)return reply.code(401).send({error:'unauthorized'});}}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test'}}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{}}));
vi.mock('../../../src/shared/logger.js',()=>({logger:{error:vi.fn()}}));
import { buildDemandReport } from '../../../src/admin/painel/queries-demand-report.js';
import { demandReportQuery,demandComparison,DemandReportLimitError } from '../../../src/admin/painel/demand-report-filter.js';
import { demandReportCsv } from '../../../src/admin/painel/demand-report-csv.js';
import { registerDemandReportRoutes } from '../../../src/admin/painel/route-demand-report.js';
import { requiredMatrixModules } from '../../../src/admin/panel-modules.js';
import type { DemandEvent,DemandSnapshot } from '../../../src/admin/painel/demand-report-types.js';
const f=demandReportQuery.parse({from:'2026-09-01',to:'2026-09-11'});
const event=(id:string,kind:DemandEvent['kind'],day='2026-09-01',municipality:string|null='São Gonçalo',measure:string|null=null):DemandEvent=>({conversation_id:id,kind,day,municipality,measure});
const data:DemandSnapshot={as_of:'2026-09-11T17:00:00Z',current:[event('a','activity'),event('a','activity','2026-09-05'),event('a','measure','2026-09-02','São Gonçalo','90/90-12'),
  event('a','measure','2026-09-06','São Gonçalo','90 90 12'),event('a','measure','2026-09-07','São Gonçalo','180/55-17'),event('a','order','2026-09-03'),event('a','order','2026-09-04'),event('a','shortage'),
  event('b','measure','2026-09-04','SAO GONCALO','90/90-12'),event('b','delivery','2026-09-07','SAO GONCALO'),event('c','activity','2026-09-03',null),event('d','activity','2026-09-11','Volta Redonda'),event('outside','activity','2026-09-12')],
  previous:[event('a','activity','2026-08-01'),event('a','order','2026-08-05')],stock:[{measure:'90/90-12',quantity:4},{measure:'90 90 12',quantity:2}]};
describe('demanda por município sem mapas',()=>{
  it('deduplica atividade e medidas sem confundir conversas, pessoas e retornos',()=>{
    const r=buildDemandReport(data,f);expect(r.summary).toEqual({conversations:4,orders:1,deliveries:1,shortages:1,conversion:25,municipalities:2,unidentified:1});
    expect(r.cities.find(c=>c.key==='sao goncalo')).toMatchObject({name:'São Gonçalo',conversations:2,orders:1,conversion:50});
    expect(r.measures).toEqual([{key:'90-90-12',measure:'90/90-12',consultations:2,stock:6},{key:'180-55-17',measure:'180/55-17',consultations:1,stock:null}]);
    expect(r.measures_summary.consultations).toBe(3);expect(JSON.stringify(r)).not.toContain('conversation_id');
  });
  it('reconcilia os totais diários e semanais para cada indicador sem contar novamente a conversa',()=>{
    for(const metric of ['conversations','orders','deliveries','shortages'] as const)for(const grain of ['day','week'] as const){
      const r=buildDemandReport(data,{...f,metric,grain,city:'sao goncalo'});
      expect(r.series.reduce((n,d)=>n+d.current,0)).toBe(r.scope[metric]);
      expect(r.series.reduce((n,d)=>n+(d.previous||0),0)).toBe(r.previous![metric]);
      expect(r.series.at(-1)?.to).toBe(f.to);
    }
    const r=buildDemandReport(data,{...f,view:'measures'});expect(r.measure_series.reduce((n,d)=>n+d.current,0)).toBe(2);
    expect(r.measure_series[1]?.current).toBe(1);expect(r.measure_series[5]?.current).toBe(0);
  });
  it('preserva municípios fora do antigo mapa, falta de localização e ausência de base',()=>{
    expect(buildDemandReport(data,{...f,city:'Volta Redonda'}).scope.conversations).toBe(1);
    expect(buildDemandReport(data,{...f,city:'__unknown__'}).scope.conversations).toBe(1);
    const missing=buildDemandReport(data,{...f,city:'Maricá'});expect(missing.scope.conversion).toBeNull();expect(missing.measures).toEqual([]);
    const empty=buildDemandReport({...data,current:[],previous:[]},f);expect(empty.summary.conversations).toBe(0);expect(empty.scope.conversion).toBeNull();
  });
  it('compara durações iguais inclusive março, ano bissexto e intervalo personalizado',()=>{
    expect(demandComparison(f)).toEqual({from:'2026-08-01',to:'2026-08-11'});
    for(const args of [{from:'2026-03-01',to:'2026-03-31'},{from:'2024-03-01',to:'2024-03-31'},{from:'2026-09-04',to:'2026-09-08',mode:'custom' as const}]){
      const current={...f,...args},old=demandComparison(current)!;expect(Date.parse(old.to)-Date.parse(old.from)).toBe(Date.parse(current.to)-Date.parse(current.from));expect(old.to<current.from).toBe(true);
    }
    expect(demandComparison({...f,compare:'false'})).toBeNull();expect(buildDemandReport(data,{...f,compare:'false'}).series.every(d=>d.previous===null)).toBe(true);
  });
  it('filtra e exporta listas completas; distingue busca da lista e detalhe selecionado',()=>{
    const r=buildDemandReport(data,{...f,citySearch:'goncalo',search:'90 90',city:'sao goncalo',view:'measures'});
    expect(r.cities).toHaveLength(1);expect(r.summary.conversations).toBe(4);expect(r.scope.conversations).toBe(2);expect(r.measures).toHaveLength(1);
    expect(r.measure_cities[0]?.consultations).toBe(2);expect(demandReportCsv(r)).toContain('Estoque físico atual');
    const many={...data,previous:[],current:Array.from({length:40},(_,i)=>event('city'+i,'activity','2026-09-01',i===0?'=HYPERLINK("evil")':'Cidade '+i))};
    const csv=demandReportCsv(buildDemandReport(many,f));expect(csv).toContain('Cidade 39');expect(csv).toContain("'=HYPERLINK");
    expect(buildDemandReport(many,f).cities).toHaveLength(40);
  });
  it('mantém autenticação, permissão Bot, validação, ambiente fixo e erro explícito nas três rotas',async()=>{
    const app=Fastify();await registerDemandReportRoutes(app);state.load.mockResolvedValue(data);
    try{for(const suffix of ['','/exportar','/imprimir']){const url='/admin/api/relatorios/demanda'+suffix+'?from=2026-09-01&to=2026-09-11';
      expect(requiredMatrixModules(url)).toEqual(['bot']);state.allow=false;expect((await app.inject({url})).statusCode).toBe(401);state.allow=true;
      const response=await app.inject({url});expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');}
      for(const params of ['environment=prod','from=2026-02-30','to=2026-08-01','grain=year','view=map','metric=profit']){const qs=new URLSearchParams({from:f.from,to:f.to});const [key,value]=params.split('=');qs.set(key!,value!);expect((await app.inject({url:'/admin/api/relatorios/demanda?'+qs})).statusCode).toBe(400);}
      const url='/admin/api/relatorios/demanda?from=2026-09-01&to=2026-09-11';state.load.mockRejectedValueOnce(new DemandReportLimitError());expect((await app.inject({url})).statusCode).toBe(422);
      state.load.mockRejectedValueOnce(Error('database'));expect((await app.inject({url})).statusCode).toBe(503);
    }finally{state.allow=true;await app.close();}
  });
});
