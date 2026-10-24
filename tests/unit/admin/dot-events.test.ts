import { createHmac } from 'node:crypto';
import { beforeAll,expect,it,vi } from 'vitest';
import { canonicalFilters,matches } from '../../../src/admin/dot/events/model.js';
import { callbackUrl,publicAddress } from '../../../src/admin/dot/events/https.js';

beforeAll(()=>{
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',
    CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test',DOT_EVENTS_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')});
});
it.each(['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1',
  '198.18.0.1','192.0.2.1','224.0.0.1','255.255.255.255','::1','::','fe80::1','fc00::1',
  '::ffff:8.8.8.8','::ffff:127.0.0.1','64:ff9b::7f00:1','2001:db8::1','2002:7f00::1','3fff::1'])('bloqueia IP não público %s',ip=>{
  expect(publicAddress(ip)).toBe(false);
});
it.each(['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])('aceita IP público %s',ip=>expect(publicAddress(ip)).toBe(true));
it.each(['http://example.com','https://a:b@example.com','https://localhost/x','https://foo.localhost',
  'https://example.com:444','https://example.com/#x','https://127.1','https://2130706433','https://[::1]'])('bloqueia callback %s',url=>{
  expect(()=>callbackUrl(url)).toThrow();
});
it('canoniza filtros sem alterar listas vazias e rejeita filtros fora do contrato',()=>{
  const a='10000000-0000-4000-8000-000000000001',b='20000000-0000-4000-8000-000000000001';
  expect(canonicalFilters({ids:[b,a,a]})).toEqual({ids:[a,b]});
  expect(matches({ids:[]},a)).toBe(false);
  expect(matches({ignorar_ids:[a]},a)).toBe(false);
  expect(matches({},a)).toBe(true);
  expect(()=>canonicalFilters({sql:'DROP TABLE'})).toThrow();
});
it('assina bytes exatos conforme Standard Webhooks e permite rotação',async()=>{
  const {signedHeaders,signingKey}=await import('../../../src/admin/dot/events/crypto.js');
  const secret='whsec_'+Buffer.alloc(32,1).toString('base64'),second='whsec_'+Buffer.alloc(32,2).toString('base64');
  const body='{"texto":"olá"}',time=1792846800000;
  const h=signedHeaders('evt_test',body,'sub_test',[secret,second],time);
  expect(h['webhook-signature'].split(' ')).toHaveLength(2);
  expect(h['webhook-signature'].split(' ')[0]).toBe('v1,'+createHmac('sha256',Buffer.alloc(32,1))
    .update('evt_test.'+Math.floor(time/1000)+'.'+body).digest('base64'));
  expect(()=>signingKey('whsec_'+Buffer.alloc(23).toString('base64'))).toThrow();
  expect(()=>signingKey('whsec_'+Buffer.alloc(65).toString('base64'))).toThrow();
});
it('cifra o segredo ligado à assinatura e valida challenge em tempo constante',async()=>{
  const {seal,unseal,equalChallenge}=await import('../../../src/admin/dot/events/crypto.js');
  const value=seal('private','sub_a');
  expect(value).not.toContain('private');expect(unseal(value,'sub_a')).toBe('private');
  expect(()=>unseal(value,'sub_b')).toThrow();
  expect(equalChallenge('abc','abc')).toBe(true);expect(equalChallenge('abc','abcd')).toBe(false);
});
it('horário silencioso usa São Paulo e falhas permanentes não são repetidas',async()=>{
  const {quietUntil,retryable,retryDelay}=await import('../../../src/admin/dot/events/policy.js');
  expect(quietUntil(new Date('2026-10-24T02:00:00Z'))?.toISOString()).toBe('2026-10-24T11:00:00.000Z');
  expect(quietUntil(new Date('2026-10-24T13:00:00Z'))).toBeNull();
  expect(retryable(410)).toBe(false);expect(retryable(413)).toBe(false);expect(retryable(429)).toBe(true);
  expect(retryDelay(1)).toBe(30);expect(retryDelay(12)).toBe(3600);
});
it('eventos desligados não exigem migration e pool de uma conexão é recusado antes de ativar',async()=>{
  const {env}=await import('../../../src/shared/config/env.js');
  const {assertDotEventsSchema}=await import('../../../src/admin/dot/events/worker.js');
  const old={enabled:env.DOT_EVENTS_ENABLED,mcp:env.DOT_MCP_ENABLED,max:env.DATABASE_POOL_MAX};
  const db={query:vi.fn()} as unknown as import('pg').Pool;
  try {
    env.DOT_EVENTS_ENABLED=false;await assertDotEventsSchema(db);expect(db.query).not.toHaveBeenCalled();
    env.DOT_EVENTS_ENABLED=true;env.DOT_MCP_ENABLED=true;env.DATABASE_POOL_MAX=1;
    await expect(assertDotEventsSchema(db)).rejects.toThrow('DATABASE_POOL_MAX');
    expect(db.query).not.toHaveBeenCalled();
  }finally{env.DOT_EVENTS_ENABLED=old.enabled;env.DOT_MCP_ENABLED=old.mcp;env.DATABASE_POOL_MAX=old.max;}
});
