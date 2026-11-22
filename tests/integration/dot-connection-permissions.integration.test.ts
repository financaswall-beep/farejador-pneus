import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { DotIdentity } from '../../src/admin/dot/token-store.js';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

const origin = 'https://farejador.example';
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
const tool = 'consultar_permissoes_milly';
let db: IntegrationDb;
let mcp: typeof import('../../src/admin/dot/mcp-server.js');
let owner: Omit<DotIdentity, 'grant_id'>;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test', DATABASE_SSL: 'false',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-emergency', DOT_MCP_ENABLED: 'true',
    DOT_MCP_PUBLIC_ORIGIN: origin, DOT_MCP_REDIRECT_URIS: redirect, DOT_MCP_CLIENT_ID: 'farejador-dot',
  });
  db = await startPostgres();
  process.env.DATABASE_URL = db.connectionString;
  vi.resetModules();
  mcp = await import('../../src/admin/dot/mcp-server.js');
  const { rows: [{ id: person_id }] } = await db.pool.query<{ id: string }>(`INSERT INTO network.partner_people
    (environment,username,password_hash) VALUES('test',$1,'hash-fixture') RETURNING id`, ['owner-' + randomUUID()]);
  const { rows: [{ id: collaborator_id }] } = await db.pool.query<{ id: string }>(`INSERT INTO network.matriz_collaborators
    (environment,person_id,display_name,job,panel_role,job_title,work_area)
    VALUES('test',$1,'Dono de teste','colaborador','owner','Dono','administrative') RETURNING id`, [person_id]);
  owner = { person_id, collaborator_id };
}, 240_000);

afterAll(async () => {
  if (!db) return;
  await (await import('../../src/persistence/db.js')).pool.end();
  await stopPostgres(db);
});

async function grant(confirmation: 'legacy' | 'conversa', enabled: boolean): Promise<DotIdentity> {
  const { rows: [{ id: grant_id }] } = await db.pool.query<{ id: string }>(`INSERT INTO network.dot_oauth_grants
    (environment,person_id,collaborator_id,client_id,resource,scope,code_hash,code_challenge,redirect_uri,
     code_used_at,operation_confirmation,finance_operations_enabled,installment_reviews_enabled,
     pickup_completion_enabled,purchase_receipt_enabled)
    VALUES('test',$1,$2,'farejador-dot',$3,'farejador.read',$4,$5,$6,now(),$7,true,true,$8,$8) RETURNING id`,
  [owner.person_id, owner.collaborator_id, origin + '/admin/dot/mcp', randomBytes(32).toString('hex'), 'a'.repeat(43), redirect, confirmation, enabled]);
  return { ...owner, grant_id };
}

it('anuncia a consulta autenticada sem parâmetros e somente leitura', () => {
  expect(mcp.listedDotTools().find(entry => entry.name === tool)).toMatchObject({
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['farejador.read'] }] },
  });
});

it('lê a configuração atual da própria conexão e apresenta os canais efetivos', async () => {
  const own = await grant('conversa', true);
  const other = await grant('legacy', false);
  const result = await mcp.invokeDotTool(own, tool, {});
  expect(result).toMatchObject({ structuredContent: {
    escopo: 'conexao_atual', modo_configurado: 'conversa', permissoes: {
      concluir_retirada: { habilitada: true, confirmacao: 'conversa', autorizacao_exigida: 'voz' },
      receber_compra_em_transito: { habilitada: true, confirmacao: 'conversa', autorizacao_exigida: 'voz' },
      cancelar_retirada: { habilitada: false, confirmacao: null },
      vencimentos: { habilitada: true, confirmacao: 'conversa' },
    },
  } });
  for (const id of [owner.person_id, owner.collaborator_id, own.grant_id, other.grant_id]) {
    expect(JSON.stringify(result)).not.toContain(id);
  }
  expect(await mcp.invokeDotTool(other, tool, {})).toMatchObject({ structuredContent: {
    modo_configurado: 'legacy', permissoes: {
      concluir_retirada: { habilitada: false, confirmacao: null, autorizacao_exigida: 'voz' },
      receber_compra_em_transito: { habilitada: false, confirmacao: null, autorizacao_exigida: 'voz' },
      financeiro: { habilitada: true, confirmacao: 'pedido_do_dono' },
      categorias_de_despesa: { habilitada: true, confirmacao: 'painel' },
      vencimentos: { habilitada: true, confirmacao: 'painel' },
    },
  } });
  await db.pool.query(`UPDATE network.dot_oauth_grants SET operation_confirmation='painel' WHERE id=$1`, [own.grant_id]);
  expect(await mcp.invokeDotTool(own, tool, {})).toMatchObject({ structuredContent: {
    modo_configurado: 'painel', permissoes: {
      concluir_retirada: { habilitada: false, confirmacao: null, autorizacao_exigida: 'voz' },
      receber_compra_em_transito: { habilitada: false, confirmacao: null, autorizacao_exigida: 'voz' },
    },
  } });
});

it('recusa identificação por argumento e não lê concessão revogada ou de outro dono', async () => {
  const own = await grant('conversa', false);
  await expect(mcp.invokeDotTool(own, tool, { grant_id: randomUUID() })).rejects.toThrow('Consulta sem parâmetros');
  const unavailable = { isError: true, content: [{ type: 'text', text: 'Permissões desta conexão indisponíveis.' }] };
  expect(await mcp.invokeDotTool({ ...own, person_id: randomUUID() }, tool, {})).toEqual(unavailable);
  await db.pool.query('UPDATE network.dot_oauth_grants SET revoked_at=now() WHERE id=$1', [own.grant_id]);
  expect(await mcp.invokeDotTool(own, tool, {})).toEqual(unavailable);
});
