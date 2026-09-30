import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const compose = readFileSync('docker-compose.farejador.coolify.yaml', 'utf8');
const metaKeys = ['META_COMMENTS_APP_ID', 'META_COMMENTS_PAGE_ACCESS_TOKEN', 'META_APP_SECRET',
  'META_GRAPH_API_VERSION', 'MARKETING_PUBLISHER_ENABLED', 'MARKETING_PUBLISHER_SEND_ENABLED'];
const baseEnv = {
  NODE_ENV: 'production', FAREJADOR_ENV: 'prod',
  DATABASE_URL: 'postgresql://postgres:fixture@example.test:6543/postgres',
  PARTNER_DATABASE_URL: 'postgresql://farejador_partner_app.projectref:fixture@example.test:6543/postgres',
  APP_COMMIT_SHA: 'a'.repeat(40), CHATWOOT_HMAC_SECRET: 'fixture-hmac-secret-24-characters',
  ADMIN_AUTH_TOKEN: 'fixture-admin-token-24-characters', ADMIN_BEARER_FALLBACK_ENABLED: 'false',
};
let parseEnv: typeof import('../../../src/shared/config/env.js').parseEnv;

beforeAll(async () => {
  Object.entries(baseEnv).forEach(([key, value]) => vi.stubEnv(key, value));
  ({ parseEnv } = await import('../../../src/shared/config/env.js'));
});
afterAll(() => vi.unstubAllEnvs());

// Resolve somente as expressões de configuração sob teste usando a semântica ${VAR:-default}.
function composeMetaEnv(source: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return Object.fromEntries(metaKeys.map(key => {
    const match = compose.match(new RegExp(`^ {6}${key}: \\$\\{([A-Z_]+):-([^}]*)\\}$`, 'm'));
    expect(match, `repasse Compose de ${key}`).not.toBeNull();
    expect(match![1]).toBe(key);
    return [key, source[key] || match![2]];
  }));
}

describe('contrato de ambiente da Central no Compose', () => {
  it('repasse opcional vazio não impede boot de produção nem habilita comentários ou envios', () => {
    const value = parseEnv({ ...baseEnv, ...composeMetaEnv() });
    expect(value.META_COMMENTS_APP_ID).toBeUndefined();
    expect(value.META_COMMENTS_PAGE_ACCESS_TOKEN).toBeUndefined();
    expect(value.META_APP_SECRET).toBeUndefined();
    expect(value.META_GRAPH_API_VERSION).toBe('v21.0');
    expect(value.MARKETING_PUBLISHER_ENABLED).toBe(false);
    expect(value.MARKETING_PUBLISHER_SEND_ENABLED).toBe(false);
    expect(value.META_COMMENTS_ENABLED).toBe(false);
    expect(value.META_COMMENTS_PUBLISH_ENABLED).toBe(false);
  });

  it('preserva App ID numérico, credenciais e versão configurados no repasse Compose', () => {
    const configured = { META_COMMENTS_APP_ID: '1234567890', META_COMMENTS_PAGE_ACCESS_TOKEN: 'fixture-page-token',
      META_APP_SECRET: 'fixture-app-secret', META_GRAPH_API_VERSION: 'v23.0' };
    const value = parseEnv({ ...baseEnv, ...composeMetaEnv(configured) });
    expect(value).toMatchObject(configured);
    expect(value.MARKETING_PUBLISHER_SEND_ENABLED).toBe(false);
    expect(value.META_COMMENTS_PUBLISH_ENABLED).toBe(false);
  });

  it('normaliza configuração opcional em branco e mantém o padrão Graph', () => {
    const value = parseEnv({ ...baseEnv, META_COMMENTS_APP_ID: ' ', META_COMMENTS_PAGE_ACCESS_TOKEN: '',
      META_APP_SECRET: '\t', META_GRAPH_API_VERSION: '' });
    expect(value.META_COMMENTS_APP_ID).toBeUndefined();
    expect(value.META_COMMENTS_PAGE_ACCESS_TOKEN).toBeUndefined();
    expect(value.META_APP_SECRET).toBeUndefined();
    expect(value.META_GRAPH_API_VERSION).toBe('v21.0');
  });

  it('continua recusando App ID não numérico e versão Graph inválida', () => {
    expect(() => parseEnv({ ...baseEnv, META_COMMENTS_APP_ID: 'app-invalido' })).toThrow(/META_COMMENTS_APP_ID/);
    expect(() => parseEnv({ ...baseEnv, META_GRAPH_API_VERSION: 'latest' })).toThrow(/META_GRAPH_API_VERSION/);
  });

  it('não aceita META_APP_ID como alias do nome efetivo', () => {
    expect(compose).not.toMatch(/^ {6}META_APP_ID:/m);
    expect(parseEnv({ ...baseEnv, META_APP_ID: '1234567890' }).META_COMMENTS_APP_ID).toBeUndefined();
  });

  it('preserva a exigência de segredo no guard do webhook Meta habilitado', () => {
    expect(() => parseEnv({ ...baseEnv, META_MESSAGING_WEBHOOK_ENABLED: 'true',
      META_MESSAGING_WEBHOOK_VERIFY_TOKEN: 'fixture-verify-token', META_APP_SECRET: ' ' })).toThrow(/META_APP_SECRET/);
  });
});
