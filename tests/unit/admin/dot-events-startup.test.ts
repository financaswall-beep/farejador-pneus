import type { Pool } from 'pg';
import { beforeEach,expect,it,vi } from 'vitest';

vi.mock('../../../src/shared/logger.js',()=>({logger:{error:vi.fn(),warn:vi.fn()}}));
let config:typeof import('../../../src/shared/config/env.js').env;
let worker:typeof import('../../../src/admin/dot/events/worker.js');
let availability:typeof import('../../../src/admin/dot/events/availability.js');
let db:Pool;

beforeEach(async()=>{
  vi.resetModules();vi.clearAllMocks();
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',
    CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test',DOT_MCP_ENABLED:'true',DOT_EVENTS_ENABLED:'true',
    DATABASE_POOL_MAX:'10',DOT_NEGOTIATION_SHADOW_CONVERSATIONS:'',
    DOT_EVENTS_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')});
  config=(await import('../../../src/shared/config/env.js')).env;
  worker=await import('../../../src/admin/dot/events/worker.js');
  availability=await import('../../../src/admin/dot/events/availability.js');
  db={query:vi.fn(async()=>({rows:[]})),connect:vi.fn()} as unknown as Pool;
});

it('não habilita eventos antes de validar a inicialização',()=>{
  expect(availability.dotEventsAvailable()).toBe(false);
  expect(availability.dotEventsState()).toMatchObject({configured:true,enabled:false,state:'pending'});
});
it.each(['','chave-invalida',Buffer.alloc(31,3).toString('base64')])('isola chave inválida sem interromper o boot: %s',async key=>{
  config.DOT_EVENTS_ENCRYPTION_KEY=key;
  await expect(worker.initializeDotEvents(db)).resolves.toMatchObject({enabled:false,state:'unavailable',reason:'invalid_encryption_key'});
  expect(db.query).not.toHaveBeenCalled();
  await worker.runEventCycle(db);
  const stop=worker.startDotEventsWorker();stop();
  expect(db.connect).not.toHaveBeenCalled();
});
it('não consulta nem exige tabelas quando o monitor está desligado',async()=>{
  config.DOT_EVENTS_ENABLED=false;
  expect(await worker.initializeDotEvents(db)).toMatchObject({enabled:false,state:'disabled'});
  expect(db.query).not.toHaveBeenCalled();
});
it.each([
  ['mcp_disabled',()=>{config.DOT_MCP_ENABLED=false;}],
  ['pool_too_small',()=>{config.DATABASE_POOL_MAX=1;}],
] as const)('isola a configuração %s sem consultar o banco',async(reason,change)=>{
  change();expect(await worker.initializeDotEvents(db)).toMatchObject({enabled:false,reason});
  expect(db.query).not.toHaveBeenCalled();
});
it('isola schema indisponível e não inclui mensagem interna nos logs',async()=>{
  vi.mocked(db.query).mockRejectedValueOnce(Object.assign(new Error('database-password-sensitive'),{code:'42P01'}));
  expect(await worker.initializeDotEvents(db)).toMatchObject({enabled:false,reason:'schema_unavailable'});
  const {logger}=await import('../../../src/shared/logger.js');
  expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('database-password-sensitive');
  expect(logger.error).toHaveBeenCalledWith({operational_alert:'dot_events_disabled',reason:'schema_unavailable'},expect.any(String));
});
it('diagnóstico de falha não inventa contadores nem acessa tabelas indisponíveis',async()=>{
  config.DOT_EVENTS_ENCRYPTION_KEY='';await worker.initializeDotEvents(db);
  const {monitorStatus}=await import('../../../src/admin/dot/events/status.js');
  expect(await monitorStatus({person_id:'owner',grant_id:'grant',collaborator_id:'owner'}))
    .toMatchObject({enabled:false,reason:'invalid_encryption_key',subscriptions:null,last_24h:null});
  expect(db.query).not.toHaveBeenCalled();
});
it('permite ativar após corrigir a chave e passar por nova inicialização',async()=>{
  const valid=config.DOT_EVENTS_ENCRYPTION_KEY;
  config.DOT_EVENTS_ENCRYPTION_KEY='';await worker.initializeDotEvents(db);
  config.DOT_EVENTS_ENCRYPTION_KEY=valid;
  expect(await worker.initializeDotEvents(db)).toMatchObject({enabled:true,state:'ready',reason:null});
  expect(db.query).toHaveBeenCalledWith('SELECT id FROM ops.dot_internal_cases LIMIT 0');
  expect(db.query).toHaveBeenCalledWith('SELECT executed_at FROM network.dot_operation_reviews LIMIT 0');
  expect(db.query).not.toHaveBeenCalledWith(expect.stringContaining('ops.dot_negotiation_shadow'));
});

it('mantém o monitor disponível e retira apenas o piloto se a tabela opcional faltar',async()=>{
  const pilot=await import('../../../src/admin/dot/events/negotiation-shadow-pilot.js');
  const {dotInstructions,listedDotTools,invokeDotTool}=await import('../../../src/admin/dot/mcp-server.js');
  const {logger}=await import('../../../src/shared/logger.js');
  config.DOT_NEGOTIATION_SHADOW_CONVERSATIONS='abcdef01-0000-4000-8000-000000000001';
  const names=()=>listedDotTools().map(tool=>tool.name);
  expect(pilot.shadowPilotAvailable()).toBe(false);
  expect(await worker.initializeDotEvents(db)).toMatchObject({enabled:true,reason:null});
  expect(names()).toEqual(expect.arrayContaining(['registrar_negociacao_sombra','consultar_negociacoes_sombra']));
  expect(dotInstructions()).toContain('registrar_negociacao_sombra');

  const failOnlyPilot = vi.fn(async (sql:string) => {
    if (sql.includes('ops.dot_negotiation_shadow')) {
      throw Object.assign(new Error('internal-schema-details'),{code:'42P01'});
    }
    return {rows:[]};
  });
  const oldSchema={query:failOnlyPilot} as unknown as Pool;
  expect(await worker.initializeDotEvents(oldSchema)).toMatchObject({enabled:true,state:'ready',reason:null});
  expect(failOnlyPilot).toHaveBeenCalledWith(expect.stringContaining('ops.dot_negotiation_shadow'));
  expect(pilot.shadowPilotEnabled()).toBe(true);
  expect(pilot.shadowPilotAvailable()).toBe(false);
  expect(names()).toContain('registrar_pendencia_interna');
  expect(names()).not.toContain('registrar_negociacao_sombra');
  expect(names()).not.toContain('consultar_negociacoes_sombra');
  expect(dotInstructions()).not.toContain('registrar_negociacao_sombra');
  await expect(invokeDotTool({person_id:'owner',grant_id:'grant',collaborator_id:'owner'},
    'consultar_negociacoes_sombra',{})).rejects.toThrow('Consulta não disponível');
  expect(logger.warn).toHaveBeenCalledWith({operational_alert:'dot_negotiation_shadow_unavailable'},expect.any(String));
  expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('internal-schema-details');
  expect(await worker.initializeDotEvents(db)).toMatchObject({enabled:true});
  expect(pilot.shadowPilotAvailable()).toBe(true);
});
