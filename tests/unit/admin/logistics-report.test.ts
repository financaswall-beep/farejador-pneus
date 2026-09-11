import Fastify from 'fastify';
import { describe,it,expect,vi } from 'vitest';
const db=vi.hoisted(()=>({connect:vi.fn(),query:vi.fn(),release:vi.fn()}));
const auth=vi.hoisted(()=>({allow:true}));
vi.mock('../../../src/persistence/db.js',()=>({pool:db}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test',MATRIZ_LOGISTICS:true}}));
vi.mock('../../../src/shared/logger.js',()=>({logger:{error:vi.fn()}}));
vi.mock('../../../src/admin/auth.js',()=>({getAdminContext:()=>({role:'admin',modules:['logistica']}),requireAdminAuth:async(_:unknown,reply:any)=>{if(!auth.allow)return reply.code(401).send({error:'unauthorized'});}}));
import { buildLogisticsReport } from '../../../src/admin/painel/queries-logistics-report.js';
import { logisticsReportQuery } from '../../../src/admin/painel/logistics-report-filter.js';
import { logisticsReportCsv } from '../../../src/admin/painel/logistics-report-csv.js';
import { readLogisticsSnapshot } from '../../../src/admin/painel/logistics-report-data.js';
import { registerLogisticsReportRoutes } from '../../../src/admin/painel/route-logistics-report.js';
import { requiredMatrixModules } from '../../../src/admin/panel-modules.js';
import type { LogisticsSnapshot,LogisticsTrip,LogisticsDelivery } from '../../../src/admin/painel/logistics-report-types.js';
const filter=logisticsReportQuery.parse({from:'2026-09-01',to:'2026-09-10'});
const trip:LogisticsTrip={id:'00000000-0000-4000-8000-000000000001',number:'R018',courier:'Carlos',courier_id:null,status:'closed',
  started_at:'2026-09-10T11:10:00.000Z',ended_at:'2026-09-10T15:30:00.000Z',day:'2026-09-10',km_start:100,km_end:148,fuel_recorded:76,financial_status:'reconciled'};
const delivery:LogisticsDelivery={id:'order1',trip_id:trip.id,order_id:'order1',number:'P001',customer:'Cliente',status:'delivered',cancelled:false,
  reason:null,scheduled:'2026-09-10',dispatched_at:trip.started_at,delivered_at:trip.ended_at,historical:false,freight:20};
const snapshot:LogisticsSnapshot={as_of:trip.ended_at!,trips:[trip,{...trip,id:'00000000-0000-4000-8000-000000000002',number:'R019',courier:'Bruno',status:'open',ended_at:null,km_end:null,financial_status:'pending'}],
  deliveries:[delivery,{...delivery,id:'order2',order_id:'order2',freight:10},
    {...delivery,id:'history1',order_id:'retry',historical:true,status:'failed',delivered_at:null,reason:'Cliente ausente',freight:null},
    {...delivery,id:'retry',order_id:'retry',trip_id:'00000000-0000-4000-8000-000000000002',freight:5}],
  expenses:[{id:'expense1',trip_id:trip.id,category:'combustivel',amount:76,occurred_at:trip.ended_at!,receipt_ids:['receipt1','receipt2'],legacy:false},
    {id:'expense2',trip_id:trip.id,category:'pedagio',amount:20,occurred_at:trip.ended_at!,receipt_ids:[],legacy:true}],
  receipts:[{id:'receipt1',trip_id:trip.id,created_at:trip.ended_at!,workflow:'linked',expense_id:'expense1',missing_expense:false},
    {id:'receipt2',trip_id:trip.id,created_at:trip.ended_at!,workflow:'linked',expense_id:'expense1',missing_expense:false}]};
describe('relatório de entregas e rotas',()=>{
  it('valida período, isolamento, filtros e limites',()=>{
    for(const extra of [{environment:'prod'},{to:'2099-01-01'},{from:'2026-02-30'},{from:'2024-01-01'},{status:'wrong'},{trip:'bad'},{view:'bad'}])
      expect(logisticsReportQuery.safeParse({...filter,...extra}).success).toBe(false);
  });
  it('fecha a conta por coorte e não soma combustível anotado nem mistura margem de pneus com frete',()=>{
    const r=buildLogisticsReport(snapshot,filter);
    expect(r.summary).toMatchObject({delivered:3,closed:1,open:1,km:48,expenses:96,closed_deliveries:2,cost_per_delivery:48,partial:false});
    expect(r.trips[0]).toMatchObject({delivered:2,deliveries:3,occurrences:1,freight:30,expenses:96,freight_balance:-66,duration_minutes:260});
    expect(r.daily.reduce((n,d)=>n+d.delivered,0)).toBe(r.summary.delivered);
    expect(r.daily.reduce((n,d)=>n+d.occurrences,0)).toBe(r.summary.occurrences);
  });
  it('preserva a falha na rota original depois de uma reentrega',()=>{
    const r=buildLogisticsReport(snapshot,{...filter,trip:trip.id,view:'deliveries'});
    expect(r.deliveries.filter(row=>row.order_id==='retry')).toMatchObject([{historical:true,result:'failed',reason:'Cliente ausente'}]);
    expect(r.trips[1]?.delivered).toBe(1);
    expect(buildLogisticsReport(snapshot,{...filter,delivery:'failed'}).deliveries).toHaveLength(1);
  });
  it('filtros de documentos e entregas não mudam o resultado das rotas; seleção e entregador restringem corretamente',()=>{
    const r=buildLogisticsReport(snapshot,{...filter,receipt:'pending',delivery:'cancelled',trip:trip.id});
    expect(r.costs).toHaveLength(0);expect(r.deliveries).toHaveLength(0);expect(r.summary.delivered).toBe(3);expect(r.expenses).toHaveLength(2);
    expect(buildLogisticsReport(snapshot,{...filter,courier:'legacy:Carlos'}).trips).toHaveLength(1);
    expect(buildLogisticsReport(snapshot,{...filter,status:'occurrences'}).trips.map(row=>row.id)).toEqual([trip.id]);
    const shuffled={...snapshot,deliveries:[...snapshot.deliveries].reverse(),expenses:[...snapshot.expenses].reverse()};
    expect(buildLogisticsReport(shuffled,filter).deliveries).toEqual(buildLogisticsReport(snapshot,filter).deliveries);
    expect(buildLogisticsReport(shuffled,filter).costs).toEqual(buildLogisticsReport(snapshot,filter).costs);
  });
  it('não transforma km, frete ou base ausentes em resultados completos',()=>{
    const r=buildLogisticsReport({...snapshot,trips:[{...trip,km_end:null}],deliveries:[{...delivery,freight:null}],expenses:[],receipts:[]},filter);
    expect(r.summary).toMatchObject({km:null,km_missing:1,partial:true});expect(r.trips[0]).toMatchObject({missing_freight:1,partial:true});
    const empty=buildLogisticsReport({...snapshot,trips:[],deliveries:[],expenses:[],receipts:[]},filter);
    expect(empty.summary.cost_per_delivery).toBeNull();expect(empty.summary.km).toBeNull();expect(empty.trips).toHaveLength(0);
  });
  it('pendências, rejeições e despesas removidas não entram como dinheiro lançado',()=>{
    const r=buildLogisticsReport({...snapshot,receipts:[...snapshot.receipts,
      {id:'pending',trip_id:trip.id,created_at:trip.ended_at!,workflow:'review_required',expense_id:null,missing_expense:false},
      {id:'removed',trip_id:trip.id,created_at:trip.ended_at!,workflow:'linked',expense_id:'deleted',missing_expense:true},
      {id:'rejected',trip_id:trip.id,created_at:trip.ended_at!,workflow:'rejected',expense_id:null,missing_expense:false}]},filter);
    expect(r.summary).toMatchObject({expenses:96,pending_receipts:2,partial:true});expect(r.costs.filter(row=>row.amount===null)).toHaveLength(3);
    expect(r.trips[0]?.receipt_approved).toBe(2);
  });
  it('deduplica despesa compartilhada no total e sinaliza o vínculo ambíguo',()=>{
    const r=buildLogisticsReport({...snapshot,trips:[trip,{...trip,id:snapshot.trips[1]!.id}],
      expenses:[...snapshot.expenses,{...snapshot.expenses[0]!,trip_id:snapshot.trips[1]!.id}]},filter);
    expect(r.summary.expenses).toBe(96);expect(r.trips.every(row=>row.shared_expense&&row.partial)).toBe(true);
  });
  it('CSV exporta toda a coleção e protege fórmulas sem incluir telefone ou endereço',()=>{
    const r=buildLogisticsReport({...snapshot,deliveries:Array.from({length:31},(_,i)=>({...delivery,id:String(i),customer:'=SUM(1)'}))},{...filter,view:'deliveries'});
    const csv=logisticsReportCsv(r);expect(csv.split('\r\n')).toHaveLength(32);expect(csv).toContain("'=SUM(1)");expect(csv).not.toMatch(/telefone|endereço/i);
    expect(logisticsReportCsv(buildLogisticsReport(snapshot,{...filter,view:'costs'}))).toContain('76,00');
  });
});
describe('rotas: consulta somente leitura e autorização',()=>{
  const setup=()=>{db.connect.mockResolvedValue(db);db.query.mockImplementation(async(sql:string)=>{
    if(sql==='SELECT now() AS as_of')return{rows:[{as_of:new Date(snapshot.as_of)}]};
    if(sql.startsWith('SELECT t.id'))return{rows:snapshot.trips};if(sql.startsWith('SELECT o.id'))return{rows:snapshot.deliveries};
    if(sql.startsWith('WITH links'))return{rows:snapshot.expenses};if(sql.startsWith('SELECT r.id'))return{rows:snapshot.receipts};return{rows:[]};});};
  it('usa snapshot transacional, limites e joins por ambiente sem buscar blobs ou dados dispensáveis',async()=>{
    setup();try{const r=await readLogisticsSnapshot(db as never,'test',filter);expect(r).toEqual(snapshot);
      expect(db.query.mock.calls[0]?.[0]).toContain('REPEATABLE READ READ ONLY');const sql=db.query.mock.calls.map(c=>c[0]).join('\n');
      expect(sql).not.toMatch(/phone|delivery_address|ai_summary|blobs|unit_cost/);expect(sql).toContain("a.environment=$1::text");expect(db.release).toHaveBeenCalled();
    }finally{vi.clearAllMocks();}
  });
  it('rejeita excesso de rotas em vez de truncar e libera conexão',async()=>{
    setup();db.query.mockImplementation(async(sql:string)=>sql==='SELECT now() AS as_of'?{rows:[{as_of:new Date(snapshot.as_of)}]}:sql.startsWith('SELECT t.id')?{rows:Array(2001).fill(trip)}:{rows:[]});
    try{await expect(readLogisticsSnapshot(db as never,'test',filter)).rejects.toThrow('logistics_report_limit');expect(db.query).toHaveBeenCalledWith('ROLLBACK');expect(db.release).toHaveBeenCalled();}finally{vi.clearAllMocks();}
  });
  it('protege as três rotas, valida filtros e distingue erro de consulta',async()=>{
    const app=Fastify();await registerLogisticsReportRoutes(app);setup();const url='/admin/api/relatorios/logistica',query='?from=2026-09-01&to=2026-09-10';
    try{for(const suffix of ['','/exportar','/imprimir'])expect(requiredMatrixModules(url+suffix)).toEqual(['logistica']);
      auth.allow=false;expect((await app.inject(url+query)).statusCode).toBe(401);auth.allow=true;
      expect((await app.inject(url+query+'&environment=prod')).statusCode).toBe(400);const r=await app.inject(url+query);expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('no-store');
      expect((await app.inject(url+'/exportar'+query)).body).toContain('Saldo dos fretes');db.query.mockRejectedValueOnce(Error('offline'));expect((await app.inject(url+query)).statusCode).toBe(503);
    }finally{await app.close();vi.clearAllMocks();}
  });
});
