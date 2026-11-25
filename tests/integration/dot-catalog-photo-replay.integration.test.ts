import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { DotIdentity } from '../../src/admin/dot/token-store.js';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

vi.mock('../../src/admin/dot/publisher-download.js', () => ({
  downloadPublisherFile: vi.fn(),
}));

const action = 'anexar_foto_catalogo';
const origin = 'https://farejador.example';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const storageOrigin = 'https://storage.example.invalid';
const downloadUrls = {
  original: 'https://attachment.example.invalid/primeiro',
  reattached: 'https://attachment.example.invalid/reenvio',
  changed: 'https://attachment.example.invalid/outro',
};

let db: IntegrationDb;
let identity: DotIdentity;
let productId: string;
let invoke: typeof import('../../src/admin/dot/mcp-server.js').invokeDotTool;
let env: typeof import('../../src/shared/config/env.js').env;
let originalJpeg: Buffer;
let changedJpeg: Buffer;
type DownloadFile = typeof import('../../src/admin/dot/publisher-download.js').downloadPublisherFile;
let download: ReturnType<typeof vi.mocked<DownloadFile>>;
const storagePut = vi.fn<(path: string) => void>();

const fakeStorageFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== storageOrigin) throw Error('Rede externa proibida neste teste');
  const bucket = 'farejador-matrix-catalog';
  if (url.pathname === '/storage/v1/bucket/' + bucket) {
    return Response.json({ public: false, file_size_limit: 10 * 1024 * 1024, allowed_mime_types: ['image/webp'] });
  }
  if (init?.method === 'POST' && url.pathname.startsWith('/storage/v1/object/' + bucket + '/test/')) {
    storagePut(url.pathname);
    return new Response(null, { status: 201 });
  }
  throw Error('Requisição inesperada de Storage');
};

beforeAll(async () => {
  db = await startPostgres();
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: db.connectionString, DATABASE_SSL: 'false',
    CHATWOOT_HMAC_SECRET: 'fixture', ADMIN_AUTH_TOKEN: 'fixture', DOT_MCP_ENABLED: 'true',
    DOT_MCP_PUBLIC_ORIGIN: origin, DOT_MCP_REDIRECT_URIS: redirectUri, DOT_MCP_CLIENT_ID: 'farejador-dot',
    MATRIZ_CATALOG_PHOTOS_ENABLED: 'true', SUPABASE_STORAGE_URL: storageOrigin,
    SUPABASE_STORAGE_SERVICE_KEY: 'fixture-storage',
  });
  vi.stubGlobal('fetch', fakeStorageFetch);
  [originalJpeg, changedJpeg] = await Promise.all(['#335577', '#884422'].map(background =>
    sharp({ create: { width: 640, height: 480, channels: 3, background } }).jpeg().toBuffer()));
  download = vi.mocked((await import('../../src/admin/dot/publisher-download.js')).downloadPublisherFile);
  download.mockImplementation(async (url, target) => {
    if (!Object.values(downloadUrls).includes(url)) throw Error('Referência de anexo inesperada');
    const bytes = url === downloadUrls.changed ? changedJpeg : originalJpeg;
    await writeFile(target, bytes, { flag: 'wx' });
    return { bytes: bytes.length, mime: 'image/jpeg' };
  });
  invoke = (await import('../../src/admin/dot/mcp-server.js')).invokeDotTool;
  env = (await import('../../src/shared/config/env.js')).env;

  const { rows: [owner] } = await db.pool.query(`INSERT INTO network.partner_people (environment,username,password_hash)
    VALUES ('test','milly-fotos-teste','fixture') RETURNING id`);
  const { rows: [collaborator] } = await db.pool.query(`INSERT INTO network.matriz_collaborators
    (environment,person_id,display_name,job,panel_role,job_title,work_area)
    VALUES ('test',$1,'Dono de teste','colaborador','owner','Dono','administrative') RETURNING id`, [owner.id]);
  const { rows: [grant] } = await db.pool.query(`INSERT INTO network.dot_oauth_grants
    (environment,person_id,collaborator_id,client_id,resource,scope,code_hash,code_challenge,redirect_uri,
      code_used_at,operation_confirmation,catalog_operations_enabled)
    VALUES ('test',$1,$2,'farejador-dot',$3,'farejador.read',$4,$5,$6,now(),'conversa',true) RETURNING id`,
  [owner.id, collaborator.id, origin + '/admin/dot/mcp', randomBytes(32).toString('hex'), 'a'.repeat(43), redirectUri]);
  identity = { person_id: owner.id, collaborator_id: collaborator.id, grant_id: grant.id };
}, 240_000);

async function setCatalogPermission(enabled: boolean) {
  await db.pool.query(`UPDATE network.dot_oauth_grants SET catalog_operations_enabled=$2
    WHERE environment='test' AND id=$1`, [identity.grant_id, enabled]);
}

beforeEach(async () => {
  const { rows: [product] } = await db.pool.query(`INSERT INTO commerce.products
    (environment,product_code,product_name,product_type) VALUES ('test',$1,'Pneu fictício','tire') RETURNING id`, [randomUUID()]);
  productId = product.id;
  await setCatalogPermission(true);
  env.MATRIZ_CATALOG_PHOTOS_ENABLED = true;
  download.mockClear();
  storagePut.mockClear();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (!db) return;
  try {
    if (invoke) await (await import('../../src/persistence/db.js')).pool.end();
  } finally {
    await stopPostgres(db);
  }
});

const call = (name: string, args: object) => invoke(identity, name, args);
type ToolResult = Awaited<ReturnType<typeof call>>;
const digest = (jpeg: Buffer) => createHash('sha256').update(jpeg).digest('hex');
async function photos() {
  return (await db.pool.query(`SELECT angle,sha256,retired_at FROM commerce.matrix_catalog_photos
    WHERE environment='test' AND product_id=$1 ORDER BY created_at`, [productId])).rows;
}

function payload() {
  return {
    product_id: productId, angle: 'front', idempotency_key: randomUUID(),
    arquivo: { file_id: 'anexo-original', file_name: 'foto.jpg', mime_type: 'image/jpeg', download_url: downloadUrls.original },
  };
}

function contents(result: ToolResult) {
  expect(result).not.toHaveProperty('isError', true);
  return result.structuredContent!;
}

function expectError(result: ToolResult, code: string) {
  expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining(code) }] });
}

async function approve(proposal: unknown, fingerprint: unknown) {
  expect(contents(await call('confirmar_operacao_milly', {
    proposta: proposal, fingerprint, autorizado_pelo_dono: true, canal_autorizacao: 'voz',
  }))).toMatchObject({ status: 'autorizada', executada: false });
}

it('reenvia o mesmo JPEG uma vez e exige nova autorização para outro conteúdo', async () => {
  const args = payload();
  const proposed = contents(await call(action, args));
  expect(proposed).toMatchObject({ status: 'aguardando_autorizacao', executada: false, confirmacao: 'conversa',
    dados: { arquivo: { file_id: args.arquivo.file_id, file_name: args.arquivo.file_name }, arquivo_sha256: digest(originalJpeg) } });
  expect(JSON.stringify(proposed)).not.toContain(args.arquivo.download_url);
  await approve(proposed.proposta, proposed.fingerprint);

  const changed = { ...args, arquivo: { ...args.arquivo, download_url: downloadUrls.changed } };
  expectError(await call(action, changed), 'dados_da_proposta_mudaram_use_nova_chave');
  expect(contents(await call('consultar_proposta_milly', { proposta: proposed.proposta })))
    .toMatchObject({ status: 'autorizada', executada: false });
  expect(storagePut).not.toHaveBeenCalled();
  expect(await photos()).toEqual([]);

  const reattached = { ...args, arquivo: { ...args.arquivo, file_id: 'anexo-reenviado', file_name: 'foto-renomeada.jpg',
    download_url: downloadUrls.reattached } };
  const saved = contents(await call(action, reattached));
  expect(saved).toMatchObject({ status: 'executada', executada: true });
  expect(download.mock.calls.filter(([url]) => url === downloadUrls.reattached)).toHaveLength(1);
  expect(contents(await call(action, args))).toEqual(saved);
  expect(storagePut).toHaveBeenCalledTimes(1);
  expect(await photos()).toEqual([{ angle: 'front', sha256: digest(originalJpeg), retired_at: null }]);

  expectError(await call(action, changed), 'idempotency_conflict');
  const newOperation = { ...changed, idempotency_key: randomUUID() };
  const secondProposal = contents(await call(action, newOperation));
  expect(secondProposal).toMatchObject({ status: 'aguardando_autorizacao', executada: false });
  expect(secondProposal.proposta).not.toBe(proposed.proposta);
  expect(storagePut).toHaveBeenCalledTimes(1);
  await approve(secondProposal.proposta, secondProposal.fingerprint);

  expect(contents(await call(action, newOperation))).toMatchObject({ status: 'executada', executada: true });
  expect(storagePut).toHaveBeenCalledTimes(2);
  expect(await photos()).toEqual([{ angle: 'front', sha256: digest(originalJpeg), retired_at: expect.any(Date) },
    { angle: 'front', sha256: digest(changedJpeg), retired_at: null }]);
});

it('preserva a autorização da conexão e a flag de catálogo antes de baixar o arquivo', async () => {
  const args = payload();
  await setCatalogPermission(false);
  expectError(await call(action, args), 'dot_catalog_disabled');

  await setCatalogPermission(true);
  env.MATRIZ_CATALOG_PHOTOS_ENABLED = false;
  expectError(await call(action, args), 'catalog_media_disabled');
  expect(download).not.toHaveBeenCalled();
  expect(storagePut).not.toHaveBeenCalled();
  expect(await photos()).toEqual([]);
});

it('exige uma nova proposta se a autorização antiga não registrou o conteúdo do arquivo', async () => {
  const { operationFingerprint } = await import('../../src/admin/painel/stage5-integrity.js');
  const args = payload();
  const legacyDetails = { product_id: args.product_id, angle: args.angle,
    arquivo: { file_id: args.arquivo.file_id, file_name: args.arquivo.file_name } };
  const fingerprint = operationFingerprint(legacyDetails);
  const { rows: [legacy] } = await db.pool.query(`INSERT INTO network.dot_operation_reviews
    (environment,grant_id,tool_name,operation_key,fingerprint,details,permission_domain)
    VALUES ('test',$1,$2,$3,$4,$5,'catalog') RETURNING id`,
  [identity.grant_id, action, args.idempotency_key, fingerprint, legacyDetails]);
  await approve(legacy.id, fingerprint);

  expectError(await call(action, args), 'dados_da_proposta_mudaram_use_nova_chave');
  expect(contents(await call('consultar_proposta_milly', { proposta: legacy.id })))
    .toMatchObject({ status: 'autorizada', executada: false, fingerprint });
  const proposed = contents(await call(action, { ...args, idempotency_key: randomUUID() }));
  expect(proposed).toMatchObject({ status: 'aguardando_autorizacao', executada: false });
  expect(proposed.proposta).not.toBe(legacy.id);
  expect(storagePut).not.toHaveBeenCalled();
  expect(await photos()).toEqual([]);
});

it('recupera o resultado de upload antigo já concluído somente para a foto gravada', async () => {
  const { reviewFingerprint } = await import('../../src/admin/dot/operation-reviews.js');
  const { operationFingerprint } = await import('../../src/admin/painel/stage5-integrity.js');
  const args = payload();
  const proposed = contents(await call(action, args));
  await approve(proposed.proposta, proposed.fingerprint);
  const saved = contents(await call(action, args));
  expect(saved).toMatchObject({ status: 'executada', executada: true });

  const legacyFingerprint = operationFingerprint({ grant: identity.grant_id, data: reviewFingerprint(args) });
  const legacyRow = await db.pool.query(`UPDATE audit.operation_idempotency SET request_fingerprint=$3
    WHERE environment='test' AND domain=$1 AND idempotency_key=$2 AND completed_at IS NOT NULL`,
  ['dot.' + action, args.idempotency_key, legacyFingerprint]);
  expect(legacyRow.rowCount).toBe(1);

  const reattached = { ...args, arquivo: { ...args.arquivo, file_id: 'anexo-antigo-reenviado', download_url: downloadUrls.reattached } };
  expect(contents(await call(action, reattached))).toEqual(saved);
  expectError(await call(action, { ...reattached, angle: 'side' }), 'idempotency_conflict');
  expectError(await call(action, { ...reattached, arquivo: { ...reattached.arquivo, download_url: downloadUrls.changed } }),
    'idempotency_conflict');
  expect(storagePut).toHaveBeenCalledTimes(1);
  expect(await photos()).toEqual([{ angle: 'front', sha256: digest(originalJpeg), retired_at: null }]);
});
