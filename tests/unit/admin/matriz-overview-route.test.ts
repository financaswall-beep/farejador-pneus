import Fastify from 'fastify';
import {describe,it,expect,vi,beforeEach} from 'vitest';
const state=vi.hoisted(()=>({read:vi.fn(),role:'owner',modules:['resumo']}));
vi.mock('../../../src/admin/auth.js',()=>({
  requireAdminAuth:async(r:any,p:any)=>{if(!r.headers.authorization)return p.code(401).send({error:'auth'});},
  getAdminContext:()=>({role:state.role,modules:state.modules}),
}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test'}}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{}}));
vi.mock('../../../src/shared/logger.js',()=>({logger:{error:vi.fn()}}));
vi.mock('../../../src/admin/painel/route-helpers.js',()=>({dashboardPayload:()=>({environment:'test'})}));
vi.mock('../../../src/admin/painel/matriz-overview.js',async(importOriginal)=>({...await importOriginal<any>(),getMatrizOverview:state.read}));
import {registerMatrizOverview} from '../../../src/admin/painel/route-matriz-overview.js';
import {overviewPeriod} from '../../../src/admin/painel/matriz-overview.js';
import {requiredMatrixModules} from '../../../src/admin/panel-modules.js';
beforeEach(()=>{state.role='owner';state.modules=['resumo'];state.read.mockReset();});
describe('Resumo: contrato HTTP e períodos',()=>{
  it('calcula hoje/7 dias/mês parcial em São Paulo e rejeita mês futuro',()=>{
    const now=new Date('2026-09-16T01:00:00Z');
    expect(overviewPeriod('today','2026-09',now)).toMatchObject({from:'2026-09-15',to:'2026-09-15'});
    expect(overviewPeriod('7d','2026-09',now).from).toBe('2026-09-09');
    expect(overviewPeriod('month','2026-09',now).to).toBe('2026-09-15');
    expect(overviewPeriod('month','2024-02',now).to).toBe('2024-02-29');
    expect(()=>overviewPeriod('month','2026-13',now)).toThrow('invalid_month');
    expect(()=>overviewPeriod('month','2026-10',now)).toThrow('invalid_month');
  });
  it('exige acesso ao Resumo e não aceita ambiente nem datas fora do contrato',async()=>{
    expect(requiredMatrixModules('/admin/api/dashboard/matriz-overview?period=month')).toEqual(['resumo']);
    const app=Fastify();await registerMatrizOverview(app);
    const url='/admin/api/dashboard/matriz-overview?period=month&month=2026-01';
    expect((await app.inject({url})).statusCode).toBe(401);
    for(const suffix of ['&environment=prod','&from=2026-01-01'])expect((await app.inject({url:url+suffix,headers:{authorization:'qa'}})).statusCode).toBe(400);
    expect((await app.inject({url:url.replace('2026-01','2999-01'),headers:{authorization:'qa'}})).statusCode).toBe(400);
    expect(state.read).not.toHaveBeenCalled();await app.close();
  });
  it('bloqueia dados financeiros sem o módulo e falhas não viram zeros',async()=>{
    const app=Fastify();await registerMatrizOverview(app);state.role='admin';state.read.mockResolvedValue({sales:{}});
    const request={url:'/admin/api/dashboard/matriz-overview?period=month&month=2026-01',headers:{authorization:'qa'}};
    const response=await app.inject(request);expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
    expect(state.read.mock.calls.at(-1)?.[1]).toBe(false);
    state.modules.push('financeiro');await app.inject(request);expect(state.read.mock.calls.at(-1)?.[1]).toBe(true);
    state.read.mockRejectedValue(Error('database offline'));
    const failed=await app.inject(request);expect(failed.statusCode).toBe(503);expect(failed.json()).toEqual({error:'overview_unavailable'});
    await app.close();
  });
});
