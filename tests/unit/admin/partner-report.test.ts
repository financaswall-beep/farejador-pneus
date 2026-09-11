import { describe,it,expect,vi } from 'vitest';
import Fastify from 'fastify';
const state=vi.hoisted(()=>({load:vi.fn(),allow:true}));
vi.mock('../../../src/admin/painel/partner-report-data.js',()=>({readPartnerSnapshot:state.load}));
vi.mock('../../../src/admin/auth.js',()=>({requireAdminAuth:async(_:unknown,reply:any)=>{if(!state.allow)return reply.code(401).send({error:'unauthorized'});}}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test'}}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{}}));
vi.mock('../../../src/shared/logger.js',()=>({logger:{error:vi.fn()}}));
import { partnerReportQuery,PartnerReportLimitError } from '../../../src/admin/painel/partner-report-filter.js';
import { buildPartnerReport,partnerReportChannel } from '../../../src/admin/painel/queries-partner-report.js';
import { partnerReportCsv } from '../../../src/admin/painel/partner-report-csv.js';
import { registerPartnerReportRoutes } from '../../../src/admin/painel/route-partner-report.js';
import { requiredMatrixModules } from '../../../src/admin/panel-modules.js';
import type { PartnerSnapshot,ReportPartnerUnit,ReportPartnerSale,ReportPartnerCommission } from '../../../src/admin/painel/partner-report-types.js';
const filter=partnerReportQuery.parse({from:'2026-09-01',to:'2026-09-10'});
const u:ReportPartnerUnit={id:'pu',partner_id:'p',unit_id:'u',name:'Loja Alcântara',partner_name:'Grupo Exemplo',city:'São Gonçalo',neighborhood:'Alcântara',status:'active',archived:false};
const s:ReportPartnerSale={id:'s1',unit_id:'u',day:'2026-09-02',source:'2w',mode:'delivery',total:220,freight:20,quantity:1,items:[{name:'Pneu',measure:'90/90-12',brand:'Marca',quantity:1,price:200,total:200}],commission_id:'c1'};
const c:ReportPartnerCommission={id:'c1',partner_id:'p',unit_id:'u',order_id:'s1',base:200,percent:7,amount:14,status:'open',day:'2026-09-02',settled_on:null,reversed_on:null,refund_status:null,refund_amount:0,refunded_on:null};
const snapshot:PartnerSnapshot={as_of:'2026-09-11T14:00:00Z',today:'2026-09-11',commission_enabled:true,
  units:[u,{...u,id:'pu2',unit_id:'u2',name:'Loja Niterói',city:'Niterói'}, {...u,id:'pu3',partner_id:'idle',unit_id:'u3',name:'Sem vendas',city:null},
    {...u,id:'pu4',partner_id:'archived',unit_id:'u4',archived:true}],
  sales:[s,{...s,id:'s2',unit_id:'u2',total:100,freight:0,source:'walkin_telefone',commission_id:null},{...s,id:'old',day:'2026-08-02',total:160,commission_id:null}],
  commissions:[c,{...c,id:'c-old',order_id:'old',day:'2026-01-01',amount:10,status:'settled',settled_on:'2026-09-03'},
    {...c,id:'c-reversed',order_id:'cancelled',status:'reversed',day:'2026-09-01',amount:5,settled_on:'2026-09-02',reversed_on:'2026-09-04',refund_status:'pending',refund_amount:5},
    {...c,id:'c-open',order_id:'old-open',day:'2026-01-02',amount:20}]};

describe('Desempenho dos parceiros',()=>{
  it('valida período, enumerações e não aceita ambiente do navegador',()=>{
    for(const bad of [{environment:'prod'},{from:'2026-02-30'},{from:'2024-01-01'},{to:'2099-01-01'},{city:'x'.repeat(81)},{partner:'abc'},{activity:'zero'},{commission_scope:'paid'},{view:'invalid'}])
      expect(partnerReportQuery.safeParse({...filter,...bad}).success).toBe(false);
  });
  it('agrupa lojas por parceiro, preserva pedidos e inclui parceiro sem vendas',()=>{
    const r=buildPartnerReport(snapshot,filter);
    expect(r.summary).toMatchObject({sales:320,orders:2,partners:2,selling:1,idle:1,previous:160,delta:100});
    expect(r.partners[0]).toMatchObject({name:'Grupo Exemplo',orders:2,ticket:160,share:100,farejador:220,direct:100});
    expect(r.partners[0]?.units).toHaveLength(2);expect(r.partners.map(p=>p.id)).not.toContain('archived');
    expect(r.daily.reduce((sum,d)=>sum+d.sales,0)).toBe(320);
    expect(r.daily.find(d=>d.day==='2026-09-02')).toMatchObject({sales:320,previous:160});
  });
  it('município usa a loja física e recorta vendas e comissões da mesma loja',()=>{
    const r=buildPartnerReport(snapshot,{...filter,city:'Niterói'});
    expect(r.summary).toMatchObject({sales:100,orders:1,generated:0,open:0,partners:1});expect(r.partners[0]?.name).toBe('Loja Niterói');
    expect(buildPartnerReport(snapshot,{...filter,city:'Sem município cadastrado'}).summary.idle).toBe(1);
    expect(r.cities).toContain('São Gonçalo');
  });
  it('separa comissão original, recebimentos, estornos e posição atual sem recalcular taxa',()=>{
    const r=buildPartnerReport(snapshot,filter);
    expect(r.summary).toMatchObject({generated:19,received:15,reversed:5,open:34,refund:5});
    expect(r.partners[0]).toMatchObject({cohort_received:5,cohort_reversed:5});
    expect(r.commissions.find(c=>c.id==='c1')).toMatchObject({base:200,percent:7,amount:14});
    expect(buildPartnerReport(snapshot,{...filter,commission_scope:'received'}).commissions.map(c=>c.id).sort()).toEqual(['c-old','c-reversed']);
    expect(buildPartnerReport(snapshot,{...filter,commission_scope:'open'}).commissions.map(c=>c.id).sort()).toEqual(['c-open','c1']);
    expect(buildPartnerReport(snapshot,{...filter,commission_scope:'refund'}).commissions).toHaveLength(1);
    expect(buildPartnerReport(snapshot,{...filter,from:'2026-07-01',to:'2026-07-31'}).summary).toMatchObject({generated:0,received:0,open:34,refund:5});
  });
  it('filtra a lista sem alterar KPIs e trata filtro global e situação explicitamente',()=>{
    const direct=buildPartnerReport(snapshot,{...filter,channel:'direct',view:'sales'});expect(direct.sales).toHaveLength(1);expect(direct.summary.sales).toBe(320);
    const idle=buildPartnerReport(snapshot,{...filter,activity:'idle'});expect(idle.partners.map(p=>p.id)).toEqual(['idle']);expect(idle.summary.sales).toBe(0);
    expect(buildPartnerReport(snapshot,{...filter,search:'grupo'}).partners).toHaveLength(1);
    expect(buildPartnerReport(snapshot,{...filter,status:'suspended'}).partners).toHaveLength(0);
    expect(buildPartnerReport(snapshot,{...filter,partner:'idle'}).sales).toHaveLength(0);
  });
  it('livro desligado é indisponível, não comissão zero ou estimativa',()=>{
    const r=buildPartnerReport({...snapshot,commission_enabled:false,commissions:[]},filter);
    expect(r.summary).toMatchObject({sales:320,generated:null,received:null,reversed:null,open:null,refund:null,unlinked:0});expect(r.sales[0]?.commission).toBeNull();
  });
  it('preserva centavos, origem desconhecida, venda sem data e base de comparação vazia',()=>{
    const r=buildPartnerReport({...snapshot,sales:[{...s,total:0.1},{...s,id:'s3',total:0.2,source:'future'},{...s,id:'undated',day:null}]},filter);
    expect(r.summary).toMatchObject({sales:0.3,orders:2,undated:1,delta:null});expect(r.partners[0]?.other).toBe(0.2);
    expect(partnerReportChannel(null)).toBe('direct');expect(partnerReportChannel('porta')).toBe('direct');expect(partnerReportChannel('future')).toBe('other');
    const empty=buildPartnerReport({...snapshot,sales:[],commissions:[]},filter);expect(empty.partners[0]?.ticket).toBeNull();expect(empty.partners[0]?.share).toBeNull();
  });
  it('exporta todas as linhas com proteção de fórmulas e sem dados pessoais',()=>{
    const many={...snapshot,sales:Array.from({length:32},(_,i)=>({...s,id:'s'+i}))};
    const csv=partnerReportCsv(buildPartnerReport(many,{...filter,view:'sales'}));expect(csv.split('\r\n')).toHaveLength(33);expect(csv.charCodeAt(0)).toBe(0xfeff);
    const injection=partnerReportCsv(buildPartnerReport({...snapshot,units:[{...u,name:'=HYPERLINK("evil")'}]},filter));
    expect(injection).toContain("'=HYPERLINK");expect(csv).not.toMatch(/customer_phone|document_number|address_street/);
    expect(partnerReportCsv(buildPartnerReport(snapshot,{...filter,view:'commissions',commission_scope:'refund'}))).toContain('Pendente');
  });
  it('protege as três rotas, valida filtros e distingue erro de resposta vazia',async()=>{
    const app=Fastify();await registerPartnerReportRoutes(app);state.load.mockResolvedValue(snapshot);
    try{for(const suffix of ['','/exportar','/imprimir']){
      const url='/admin/api/relatorios/parceiros'+suffix+'?from=2026-09-01&to=2026-09-10';
      expect(requiredMatrixModules(url)).toEqual(['rede']);state.allow=false;expect((await app.inject({url})).statusCode).toBe(401);
      state.allow=true;const response=await app.inject({url});expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
      if(suffix==='/exportar')expect(response.headers['content-type']).toContain('text/csv');else expect(response.json().summary.sales).toBe(320);
    }
    expect((await app.inject({url:'/admin/api/relatorios/parceiros?from=2026-09-01&to=2026-09-10&environment=prod'})).statusCode).toBe(400);
    state.load.mockRejectedValueOnce(new PartnerReportLimitError());expect((await app.inject({url:'/admin/api/relatorios/parceiros?from=2026-09-01&to=2026-09-10'})).statusCode).toBe(422);
    state.load.mockRejectedValueOnce(new Error('db down'));expect((await app.inject({url:'/admin/api/relatorios/parceiros?from=2026-09-01&to=2026-09-10'})).statusCode).toBe(503);
    }finally{await app.close();state.allow=true;}
  });
});
