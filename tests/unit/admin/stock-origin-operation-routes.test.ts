import Fastify,{ type FastifyRequest } from 'fastify';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { CaixaAuth } from '../../../src/admin/caixa/queries.js';

const mocks=vi.hoisted(()=>({list:vi.fn(),confirm:vi.fn(),receipt:vi.fn(),pickups:vi.fn(),deliveries:vi.fn()}));
vi.mock('../../../src/admin/painel/stock-origin.js',()=>({listStockOriginPendings:mocks.list,confirmStockOrigin:mocks.confirm}));
vi.mock('../../../src/admin/caixa/my-sales.js',()=>({getCaixaMySaleDetail:mocks.receipt}));
vi.mock('../../../src/admin/painel/queries-pickups.js',()=>({getMatrizRetiradas:mocks.pickups}));
vi.mock('../../../src/admin/caixa/delivery-presentation.js',()=>({getDeliveryPresentation:mocks.deliveries}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{}}));
let app:ReturnType<typeof Fastify>;
let register:typeof import('../../../src/admin/caixa/route-stock-origins.js').registerCaixaStockOriginRoutes;
const order='1a111111-1111-4111-8111-111111111111',pending='2a222222-2222-4222-8222-222222222222';
const channel=(s:string)=>'/api/caixa/origens/'+s+'/'+order;
const body={selections:[{candidate_id:order,quantity:1}],idempotency_key:order};

beforeAll(async()=>{
  Object.assign(process.env,{FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test',MATRIZ_LOGISTICS:'true'});
  ({registerCaixaStockOriginRoutes:register}=await import('../../../src/admin/caixa/route-stock-origins.js'));
});
beforeEach(async()=>{
  vi.resetAllMocks(); app=Fastify();
  register(app,[async(req,reply)=>{
    const module=req.headers.authorization;
    if(!module){await reply.code(401).send({});return;}
    (req as FastifyRequest & {caixa:CaixaAuth}).caixa={collaboratorId:'operator',displayName:'Teste',username:'teste',
      modules:{vendas:module==='vendas',entregas:module==='entregas',retiradas:module==='retiradas'}} as CaixaAuth;
  }]); await app.ready();
});
afterEach(async()=>{await app.close();});

it('protege as pendências por módulo, vendedor e pedido',async()=>{
  expect((await app.inject({url:channel('vendas')})).statusCode).toBe(401);
  expect((await app.inject({url:channel('vendas'),headers:{authorization:'entregas'}})).statusCode).toBe(403);
  mocks.receipt.mockResolvedValue(null);
  const write=()=>app.inject({method:'POST',url:channel('vendas')+'/'+pending,headers:{authorization:'vendas'},payload:body});
  expect((await write()).statusCode).toBe(404);
  expect(mocks.confirm).not.toHaveBeenCalled();
  mocks.receipt.mockResolvedValue({status:'paid'});mocks.confirm.mockResolvedValue({id:pending,status:'confirmed'});
  expect((await write()).json().status).toBe('confirmed');
  expect(mocks.receipt).toHaveBeenCalledWith('test','operator',order,expect.anything(),'own');
  expect(mocks.confirm).toHaveBeenCalledWith(expect.anything(),'test',{...body,pending_id:pending},expect.stringContaining('teste'),order);
});

it('respeita fila de entrega ativa e retirada aberta',async()=>{
  mocks.deliveries.mockResolvedValue(new Map([[order,{delivery_status:'dispatched'}]]));
  mocks.pickups.mockResolvedValue([{status:'delivered'}]);
  for(const key of ['entregas','retiradas'])expect((await app.inject({url:channel(key),headers:{authorization:key}})).statusCode).toBe(404);
  expect(mocks.list).not.toHaveBeenCalled();
  mocks.deliveries.mockResolvedValue(new Map([[order,{delivery_status:'pending'}]]));
  mocks.pickups.mockResolvedValue([{status:'open'}]);mocks.list.mockResolvedValue([]);
  for(const key of ['entregas','retiradas'])expect((await app.inject({url:channel(key),headers:{authorization:key}})).json()).toEqual({rows:[]});
  expect(mocks.list).toHaveBeenCalledWith(expect.anything(),'test',{orderIds:[order]});
});
