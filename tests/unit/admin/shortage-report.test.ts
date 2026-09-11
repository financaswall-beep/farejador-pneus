import { describe,it,expect,vi } from 'vitest';
import Fastify from 'fastify';
const state=vi.hoisted(()=>({load:vi.fn(),allow:true}));
vi.mock('../../../src/admin/painel/shortage-report-data.js',()=>({readShortageSnapshot:state.load}));
vi.mock('../../../src/admin/auth.js',()=>({requireAdminAuth:async(_:unknown,reply:any)=>{if(!state.allow)return reply.code(401).send({error:'unauthorized'});}}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test'}}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{}}));
vi.mock('../../../src/shared/logger.js',()=>({logger:{error:vi.fn()}}));
import { shortageReportQuery,ShortageReportLimitError } from '../../../src/admin/painel/shortage-report-filter.js';
import { buildShortageReport } from '../../../src/admin/painel/queries-shortage-report.js';
import { shortageReference } from '../../../src/admin/painel/shortage-report-potential.js';
import { shortageReportCsv,shortageReportCell } from '../../../src/admin/painel/shortage-report-csv.js';
import { registerShortageReportRoutes } from '../../../src/admin/painel/route-shortage-report.js';
import { requiredMatrixModules } from '../../../src/admin/panel-modules.js';
import type { ShortageSnapshot,ShortageTrace,ShortageProduct } from '../../../src/admin/painel/shortage-report-types.js';
const partner='00000000-0000-4000-8000-000000000001';
const f=shortageReportQuery.parse({from:'2026-09-01',to:'2026-09-10',store:partner});
const p:ShortageProduct={id:'p1',measure:'90/90-12',brand:'Michelin',condition:'novo',position:'front',matrix_price:210.15,matrix_currency:'BRL',partner_price:180.35,partner_currency:'BRL'};
const t:ShortageTrace={id:'s1',conversation_id:'c1',search_key:'k1',occurred_at:'2026-09-10T13:00:00Z',measure:'90/90-12',municipality:'São Gonçalo',filters:{marca:'Michelin',condicao_pneu:'novo'},stores:[{id:partner,name:'Parceiro Alcântara',available:false},{id:'matriz',name:'Matriz',available:false}]};
const data:ShortageSnapshot={as_of:'2026-09-11T14:00:00Z',tracking_since:'2026-09-01T13:00:00Z',legacy_records:2,cities:[{id:partner,city:'São Gonçalo'}],
  traces:[t,{...t,id:'s2',search_key:'k2',measure:'90 / 90 - 12'}, {...t,id:'s3',conversation_id:'c2',search_key:'k3'},
    {...t,id:'s4',search_key:'k1',measure:'180/55-17',stores:[{id:partner,name:'Parceiro Alcântara',available:false},{id:'matriz',name:'Matriz',available:true}]}],
  products:[p,{...p,id:'p2',brand:'Outra',matrix_price:1,partner_price:1},{...p,id:'p3',condition:'meia_vida',partner_price:2}],
  stock:[{store_id:partner,measure:'90/90-12',available:4,unknown:false},{store_id:partner,measure:'90 90 12',available:2,unknown:false},{store_id:'matriz',measure:'90/90-12',available:0,unknown:false}]};
describe('relatório de faltas e receita potencial',()=>{
  it('separa consultas, faltas por loja e medidas; agrupa repetições sem duplicar a estimativa',()=>{
    const r=buildShortageReport(data,f);
    expect(r.summary).toEqual({consultations:3,shortages:7,stores:2,measures:2});
    expect(r.store?.potential).toMatchObject({amount:360.7,opportunities:3,priced:2,unpriced:1,repeated:1});
    expect(r.measures[0]).toMatchObject({shortages:3,stock:6,potential:{amount:360.7,opportunities:2,repeated:1}});
    expect(r.consultations).toHaveLength(3);expect(r.consultations[0]).not.toHaveProperty('conversation_id');
    expect(r.consultations[0]).not.toHaveProperty('search_key');expect(r.consultations[0]!.stores).toHaveLength(2);
    expect(r.store?.city).toBe('São Gonçalo');expect(r.legacy_records).toBe(2);
  });
  it('usa preço da Matriz ou da Rede e não produz total monetário da rede',()=>{
    const r=buildShortageReport(data,{...f,store:'matriz'});
    expect(r.store?.potential.amount).toBe(420.3);expect(r.measures[0]?.stock).toBe(0);
    expect(r.summary).not.toHaveProperty('amount');expect(r.stores[0]).not.toHaveProperty('potential');
    expect(buildShortageReport(data,{...f,store:'00000000-0000-4000-8000-000000000099'}).store).toBeNull();
  });
  it('respeita marca, condição e posição; nunca usa preço desconhecido, zero, vencido filtrado na SQL ou moeda estrangeira',()=>{
    expect(shortageReference({...t,filters:{marca:'Michelin',condicao_pneu:'novo',posicao_pneu:'front'}},partner,data.products)?.amount).toBe(180.35);
    expect(shortageReference({...t,filters:{posicao_pneu:'rear'}},partner,[p])).toBeNull();
    expect(shortageReference({...t,filters:{posicao_pneu:'rear'}},partner,[{...p,position:null}])).toBeNull();
    expect(shortageReference({...t,filters:{posicao_pneu:'rear'}},partner,[{...p,position:'both'}])?.amount).toBe(180.35);
    expect(shortageReference({...t,filters:{condicao_pneu:'qualquer-inválida'}},partner,[p])).toBeNull();
    for(const bad of [{...p,partner_price:0},{...p,partner_price:null},{...p,partner_currency:'USD'},{...p,partner_price:NaN}])expect(shortageReference(t,partner,[bad])).toBeNull();
    expect(shortageReference({...t,filters:{}},partner,data.products)?.amount).toBe(1);
  });
  it('escolhe a menor referência entre buscas agrupadas, sem contar a mesma conversa duas vezes',()=>{
    const r=buildShortageReport({...data,traces:[t,{...t,id:'again',search_key:'other',filters:{}}]},f);
    expect(r.store?.potential).toMatchObject({amount:1,opportunities:1,repeated:1});
    expect(r.opportunities[0]?.searches).toBe(2);
  });
  it('não transforma falta de informação em zero e mantém estoque atual separado da consulta',()=>{
    const r=buildShortageReport({...data,products:[],stock:[...data.stock,{store_id:partner,measure:'90/90-12',available:0,unknown:true}]},f);
    expect(r.store?.potential).toMatchObject({amount:null,priced:0,unpriced:3});expect(r.measures[0]?.stock).toBeNull();
    const d=buildShortageReport(data,{...f,measure:'180/55-17'});expect(d.consultations[0]?.available_elsewhere).toBe(true);expect(d.selected_measure?.stock).toBeNull();
    const empty=buildShortageReport({...data,traces:[]},f);expect(empty.summary.shortages).toBe(0);expect(empty.store).toBeNull();
  });
  it('filtra medida e consulta sem perder a trilha; exporta todas as páginas sem somar as repetições',()=>{
    const r=buildShortageReport(data,{...f,view:'consultations'});expect(r.consultations).toHaveLength(4);
    const searched=buildShortageReport(data,{...f,search:'180 55'});expect(searched.measures).toHaveLength(1);expect(searched.selected_measure?.measure).toBe('180/55-17');
    expect(shortageReportCsv(r)).toContain('Matriz: tinha');expect(shortageReportCsv(r)).toContain('não somar as consultas');
    const csv=shortageReportCsv(buildShortageReport(data,{...f,view:'potential'}));expect(csv).toContain('180,35');expect(csv).toContain('Sem referência');
    expect(csv).toContain('não lucro nem perda confirmada');expect(shortageReportCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(shortageReportCell('\t+1')).toBe('"\'\t+1"');
  });
  it('protege as rotas, não aceita mudar ambiente e distingue falha, limite e período vazio',async()=>{
    const app=Fastify();await registerShortageReportRoutes(app);state.load.mockResolvedValue(data);
    try{for(const suffix of ['','/exportar','/imprimir']){
      const url='/admin/api/relatorios/faltas'+suffix+'?from=2026-09-01&to=2026-09-10';
      expect(requiredMatrixModules(url)).toEqual(['bot']);state.allow=false;expect((await app.inject({url})).statusCode).toBe(401);
      state.allow=true;const response=await app.inject({url});expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
      if(suffix==='/exportar')expect(response.headers['content-type']).toContain('text/csv');else expect(response.json().summary.shortages).toBe(7);
    }
    for(const args of ['environment=prod','from=2026-02-30','to=2026-08-01','store=invalid']){
      const qs=new URLSearchParams({from:f.from,to:f.to});const [key,value]=args.split('=');qs.set(key!,value!);
      expect((await app.inject({url:'/admin/api/relatorios/faltas?'+qs})).statusCode).toBe(400);
    }
    state.load.mockRejectedValueOnce(new ShortageReportLimitError());expect((await app.inject({url:'/admin/api/relatorios/faltas?from=2026-09-01&to=2026-09-10'})).statusCode).toBe(422);
    state.load.mockRejectedValueOnce(new Error('db down'));expect((await app.inject({url:'/admin/api/relatorios/faltas?from=2026-09-01&to=2026-09-10'})).statusCode).toBe(503);
    }finally{state.allow=true;await app.close();}
  });
});
