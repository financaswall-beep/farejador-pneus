import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
const database = vi.hoisted(() => ({ query: vi.fn() }));
const auth = vi.hoisted(() => ({ allow: true, owner: false, finance: false }));
vi.mock('../../../src/persistence/db.js', () => ({ pool: database }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: { FAREJADOR_ENV: 'test' } }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { error: vi.fn() } }));
vi.mock('../../../src/shared/business-time.js', () => ({ businessDateSaoPaulo: () => '2026-09-10' }));
vi.mock('../../../src/admin/auth.js', () => ({
  requireAdminAuth: async (_: unknown, reply: {code:(n:number)=>{send:(v:unknown)=>unknown}}) => {
    if (!auth.allow) return reply.code(401).send({error:'unauthorized'});
  },
  getAdminContext: () => ({role:auth.owner?'owner':'admin',modules:auth.finance?['compras','financeiro']:['compras']}),
}));
import { purchaseReportQuery } from '../../../src/admin/painel/purchase-report-period.js';
import { buildPurchaseReport } from '../../../src/admin/painel/queries-purchase-report.js';
import { purchaseReportCsv } from '../../../src/admin/painel/purchase-report-csv.js';
import { registerPurchaseReportRoutes } from '../../../src/admin/painel/route-purchase-report.js';
import { requiredMatrixModules } from '../../../src/admin/panel-modules.js';
import type { PurchaseReportLine } from '../../../src/admin/painel/purchase-report-data.js';
const filter = purchaseReportQuery.parse({from:'2026-09-01',to:'2026-09-10'});
const row: PurchaseReportLine = {id:'item',purchase_id:'purchase',order_code:'OC-2026-000001',day:'2026-09-01',received_on:'2026-09-02',
  supplier_id:'00000000-0000-4000-8000-000000000001',supplier_name:'Fornecedor',status:'confirmed',full_total:35000,open:15000,
  measure:'90/90-12',brand:'Pirelli',condition:'novo',quantity:2,ordered:3,received:2,transit:0,value:25000,base_unit_cost:12000};
const second = {...row,id:'second',measure:'130/70-13',quantity:1,ordered:1,received:1,value:10000};

describe('relatório de compras: valores históricos e recortes', () => {
  it('rejeita datas falsas, futuro, ambiente, fornecedor inválido e campos desconhecidos', () => {
    for (const value of [{from:'2026-02-30'},{to:'2026-09-11'},{from:'2026-09-10',to:'2026-09-01'},
      {environment:'prod'},{supplier:'bad'},{receipt:'cancelled'},{offset:-1},{view:'other'},{from:'2024-01-01'}])
      expect(purchaseReportQuery.safeParse({...filter,...value}).success).toBe(false);
  });
  it('deduplica compras e pagamentos, e calcula o custo médio ponderado com rateio', () => {
    const report=buildPurchaseReport([row,second],filter,true);
    expect(report.summary).toMatchObject({purchases:1,quantity:3,ordered:4,received:3,transit:0,value:350,average_cost:116.67,full_total:350,paid:200,open:150,suppliers:1});
    expect(report.products[0]).toMatchObject({quantity:2,average_cost:125});
    expect(report.purchases.rows[0].items).toHaveLength(2);
    expect(report.daily[0].value).toBe(350);
  });
  it('filtra a variante exata mantendo pagamentos da compra inteira sem rateio artificial', () => {
    const report=buildPurchaseReport([row,second,{...row,id:'wrong',measure:'190/90-12'},
      {...row,id:'brand',brand:'Michelin'}],{...filter,measure:'90/90-12',exact:'true',brand:'Pirelli'},true);
    expect(report.summary).toMatchObject({value:250,quantity:2,full_total:350,paid:200,open:150});
    expect(report.item_filtered).toBe(true);expect(report.purchases.rows[0].items).toHaveLength(1);
    expect(report.facets.brands).toEqual(['Michelin','Pirelli']);
  });
  it('compara custo da mesma marca/medida/condição e separa trânsito de recebimento', () => {
    const report=buildPurchaseReport([row,{...second,status:'pending',received:0,transit:1},
      {...row,id:'old',purchase_id:'old',day:'2026-08-01',value:20000},
      {...row,id:'other',purchase_id:'other',day:'2026-08-01',brand:'Michelin',value:6000}],filter,true);
    expect(report.products[0]).toMatchObject({average_cost:125,previous_average:100,change_pct:25});
    expect(report.summary).toMatchObject({received:2,transit:1});
    expect(buildPurchaseReport([row,{...second,status:'pending'}],{...filter,receipt:'received'},true).summary.value).toBe(250);
    expect(buildPurchaseReport([row],{...filter,supplier:'different'},true).summary.quantity).toBe(0);
    expect(buildPurchaseReport([{...row,quantity:0,received:0,value:0}],filter,true).summary.average_cost).toBeNull();
  });
  it('oculta pagamentos em todas as estruturas quando não há acesso financeiro', () => {
    const report=buildPurchaseReport([row,second],filter,false);
    const inspect=(value:unknown):void=>{
      if(!value||typeof value!=='object')return;
      for(const [key,child] of Object.entries(value)){
        if(['full_total','paid','open'].includes(key))expect(child).toBeNull();else inspect(child);
      }
    };inspect(report);expect(report.summary.value).toBe(350);
  });
  it('exporta todas as compras, uma linha por compra, e neutraliza fórmulas no CSV', () => {
    const rows=Array.from({length:30},(_,i)=>({...row,id:'item-'+i,purchase_id:'purchase-'+i,supplier_name:'=SUM(1)'}));
    const report=buildPurchaseReport(rows,{...filter,offset:25,view:'purchases'},true);
    expect(report.purchases.rows).toHaveLength(5);expect(report.export_purchases).toHaveLength(30);
    const csv=purchaseReportCsv(report);expect(csv.split('\r\n')).toHaveLength(31);expect(csv).toContain("'=SUM(1)");
    expect(csv).toContain('Pago da compra inteira');
    expect(purchaseReportCsv(buildPurchaseReport(rows,{...filter,view:'suppliers'},false))).not.toContain('Em aberto');
    expect(purchaseReportCsv(buildPurchaseReport([row,second],{...filter,view:'products'},true)).split('\r\n')).toHaveLength(3);
  });
});

describe('rotas de compras', () => {
  it('associa todas as consultas à permissão Compras', () => {
    for(const suffix of ['', '/exportar', '/imprimir']) expect(requiredMatrixModules('/admin/api/relatorios/compras'+suffix)).toEqual(['compras']);
  });
  it('valida autenticação, filtra pagamentos e retorna exportação completa', async () => {
    const app=Fastify();await registerPurchaseReportRoutes(app);const url='/admin/api/relatorios/compras',query='?from=2026-09-01&to=2026-09-10&view=purchases';
    const raw={...row,full_total:'350.00',open:'150.00',value:'250.00',base_unit_cost:'120.00'};
    try{
      auth.allow=false;expect((await app.inject(url+query)).statusCode).toBe(401);auth.allow=true;
      expect((await app.inject(url+query+'&environment=prod')).statusCode).toBe(400);expect(database.query).not.toHaveBeenCalled();
      database.query.mockResolvedValue({rows:Array.from({length:30},(_,i)=>({...raw,id:'i'+i,purchase_id:'p'+i}))});
      const response=await app.inject(url+query);expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().purchases.rows).toHaveLength(25);expect(response.json().summary.paid).toBeNull();
      expect(response.json()).not.toHaveProperty('export_purchases');
      expect((await app.inject(url+'/imprimir'+query)).json().purchases.rows).toHaveLength(30);
      const csv=await app.inject(url+'/exportar'+query);expect(csv.body.split('\r\n')).toHaveLength(31);expect(csv.body).not.toContain('Pago');
      auth.finance=true;expect((await app.inject(url+query)).json().summary.paid).toBe(6000);
      expect(database.query.mock.calls.at(-1)?.[1][0]).toBe('test');
    }finally{auth.finance=false;database.query.mockReset();await app.close();}
  });
  it('falhas e excesso de dados não se passam por ausência de compras', async () => {
    const app=Fastify();await registerPurchaseReportRoutes(app);const url='/admin/api/relatorios/compras?from=2026-09-01&to=2026-09-10';
    try{
      database.query.mockResolvedValueOnce({rows:Array(50001).fill(row)});expect((await app.inject(url)).statusCode).toBe(422);
      database.query.mockRejectedValueOnce(new Error('offline'));expect((await app.inject(url)).statusCode).toBe(503);
    }finally{database.query.mockReset();await app.close();}
  });
});
