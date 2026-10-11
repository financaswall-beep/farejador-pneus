import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => {
  Object.assign(process.env, { NODE_ENV:'test', FAREJADOR_ENV:'test', DATABASE_URL:'postgres://test',
    CHATWOOT_HMAC_SECRET:'test-secret', ADMIN_AUTH_TOKEN:'test-admin-token' });
  return { get: vi.fn(), save: vi.fn(), role: 'owner' };
});
vi.mock('../../../src/parceiro/db.js', () => ({ partnerPool: { query:vi.fn() } }));
vi.mock('../../../src/parceiro/auth.js', async original => ({
  ...await original<typeof import('../../../src/parceiro/auth.js')>(),
  requirePartnerAuth: async (request: any) => { request.partnerContext = { environment:'test', partnerUnitId:'unit-a',
    slug:'loja-a', role:mocks.role, tokenId:'operator-a' }; },
}));
vi.mock('../../../src/parceiro/store-hours.js', () => ({ getPartnerStoreHours:mocks.get, savePartnerStoreHours:mocks.save }));
import { registerPartnerStoreHoursRoutes } from '../../../src/parceiro/route-store-hours.js';
const url = '/parceiro/loja-a/api/configuracoes/horarios';
beforeEach(() => { mocks.role='owner'; mocks.get.mockReset().mockResolvedValue({ hours:null,legacy_text:'antigo',schema_ready:true });
  mocks.save.mockReset().mockResolvedValue({ hours:[],schema_ready:true }); });
describe('API dos horários por dia', () => {
  it('usa somente a loja da sessão e aceita fechamento explícito da semana', async () => {
    const app=Fastify(); registerPartnerStoreHoursRoutes(app);
    try {
      expect((await app.inject({ method:'GET',url })).json().legacy_text).toBe('antigo');
      expect((await app.inject({ method:'PUT',url,payload:{hours:[]} })).statusCode).toBe(200);
      expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ partnerUnitId:'unit-a',environment:'test' }),[]);
    } finally { await app.close(); }
  });
  it.each([
    {hours:[{day:1,opens_at:'18:00',closes_at:'08:00'}]},
    {hours:[{day:1,opens_at:'08:00',closes_at:'18:00'},{day:1,opens_at:'09:00',closes_at:'19:00'}]},
    {hours:[],partnerUnitId:'unit-b'}, {hours:null},
  ])('recusa horários inválidos ou tentativa de mudar unidade %j', async payload => {
    const app=Fastify(); registerPartnerStoreHoursRoutes(app);
    try { expect((await app.inject({ method:'PUT',url,payload })).statusCode).toBe(400); expect(mocks.save).not.toHaveBeenCalled(); }
    finally { await app.close(); }
  });
  it.each(['GET','PUT'] as const)('funcionário não pode %s horário mesmo com outras permissões', async method => {
    mocks.role='funcionario'; const app=Fastify(); registerPartnerStoreHoursRoutes(app);
    try { expect((await app.inject({ method,url,...(method==='PUT'?{payload:{hours:[]}}:{}) })).statusCode).toBe(403);
      expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled(); }
    finally { await app.close(); }
  });
  it('ausência da migration retorna erro legível, sem sucesso falso', async () => {
    mocks.save.mockRejectedValue(Object.assign(new Error('column missing'),{code:'42703'}));
    const app=Fastify(); registerPartnerStoreHoursRoutes(app);
    try { expect((await app.inject({ method:'PUT',url,payload:{hours:[]} })).statusCode).toBe(503); }
    finally { await app.close(); }
  });
});
