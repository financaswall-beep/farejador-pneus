import Fastify from 'fastify';
import { describe,it,expect,vi } from 'vitest';
const mocks=vi.hoisted(()=>({get:vi.fn(),details:vi.fn(),csv:vi.fn(),allow:true}));
vi.mock('../../../src/admin/auth.js',()=>({requireAdminAuth:async(_r:unknown,reply:{code:(n:number)=>{send:(v:unknown)=>void}})=>{if(!mocks.allow)return reply.code(401).send({error:'unauthorized'});}}));
vi.mock('../../../src/shared/business-time.js',()=>({businessDateSaoPaulo:()=> '2026-09-10'}));
vi.mock('../../../src/admin/painel/queries-bot-faltas.js',()=>({getBotShortages:mocks.get,getBotShortageConsultations:mocks.details,exportBotShortages:mocks.csv}));
import {registerBotShortageRoutes,shortageCsvCell} from '../../../src/admin/painel/route-bot-faltas.js';
describe('acesso e limites do relatório de faltas',()=>{
 it('protege todas as rotas, valida período/filtros e distingue falha de vazio',async()=>{
  const app=Fastify();await registerBotShortageRoutes(app);
  try{
   mocks.allow=false;
   for(const suffix of ['', '/consultas','/exportar'])expect((await app.inject('/admin/api/bot/faltas'+suffix+'?from=2026-09-01&to=2026-09-10')).statusCode).toBe(401);
   mocks.allow=true;
   for(const query of ['from=2026-02-31&to=2026-03-01','from=2026-09-10&to=2026-09-01','from=2026-09-01&to=2026-09-11','from=2024-01-01&to=2026-09-10','from=2026-09-01&to=2026-09-10&environment=prod','from=2026-09-01&to=2026-09-10&store=unknown']) {
    expect((await app.inject('/admin/api/bot/faltas?'+query)).statusCode).toBe(400);
   }
   mocks.get.mockResolvedValue({shortages:0});const empty=await app.inject('/admin/api/bot/faltas?from=2026-09-01&to=2026-09-10');
   expect(empty.statusCode).toBe(200);expect(empty.headers['cache-control']).toBe('no-store');
   mocks.get.mockRejectedValueOnce(new Error('database offline'));
   expect((await app.inject('/admin/api/bot/faltas?from=2026-09-01&to=2026-09-10')).statusCode).toBe(503);
  }finally{await app.close();}
 });
 it('CSV neutraliza fórmulas e mantém aspas, acentos e quebras de linha',()=>{
  expect(shortageCsvCell(' =HYPERLINK("x")')).toBe('"\' =HYPERLINK(""x"")"');
  expect(shortageCsvCell('São Gonçalo\nMatriz')).toBe('"São Gonçalo\nMatriz"');
 });
});
