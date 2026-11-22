import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { DotIdentity } from '../../src/admin/dot/token-store.js';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

const origin = 'https://farejador.example';
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
const lookup = 'consultar_compra_para_receber';
const receipt = 'confirmar_recebimento_compra';
let db: IntegrationDb;
let identity: DotIdentity;
let server: typeof import('../../src/admin/dot/mcp-server.js');
let purchases: typeof import('../../src/admin/painel/queries-fornecedores-registro.js');

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_SSL: 'false',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-emergency',
    DOT_MCP_ENABLED: 'true', DOT_MCP_PUBLIC_ORIGIN: origin,
    DOT_MCP_REDIRECT_URIS: callback, DOT_MCP_CLIENT_ID: 'farejador-dot',
    MATRIZ_CENTRAL_LEDGER: 'true', MATRIZ_CENTRAL_LEDGER_READ: 'true', WHOLESALE_FINANCE: 'true',
  });
  db = await startPostgres();
  process.env.DATABASE_URL = db.connectionString;
  vi.resetModules();
  server = await import('../../src/admin/dot/mcp-server.js');
  purchases = await import('../../src/admin/painel/queries-fornecedores-registro.js');
  const { rows: [owner] } = await db.pool.query(`INSERT INTO network.partner_people(environment,username,password_hash)
    VALUES('test','milly-receipt-owner','hash-fixture') RETURNING id`);
  const { rows: [collaborator] } = await db.pool.query(`INSERT INTO network.matriz_collaborators
    (environment,person_id,display_name,job,panel_role,job_title,work_area)
    VALUES('test',$1,'Dono teste','colaborador','owner','Dono','administrative') RETURNING id`, [owner.id]);
  const { rows: [grant] } = await db.pool.query(`INSERT INTO network.dot_oauth_grants
    (environment,person_id,collaborator_id,client_id,resource,scope,code_hash,code_challenge,redirect_uri,code_used_at)
    VALUES('test',$1,$2,'farejador-dot',$3,'farejador.read',$4,$5,$6,now()) RETURNING id`,
  [owner.id, collaborator.id, `${origin}/admin/dot/mcp`, createHash('sha256').update(randomUUID()).digest('hex'), 'a'.repeat(43), callback]);
  identity = { person_id: owner.id, collaborator_id: collaborator.id, grant_id: grant.id };
}, 240_000);

afterAll(async () => {
  if (!db) return;
  try {
    const { pool } = await import('../../src/persistence/db.js');
    await pool.end();
  } finally {
    await stopPostgres(db);
  }
});

const call = (name: string, args: object) => server.invokeDotTool(identity, name, args);
function contents(result: Awaited<ReturnType<typeof call>>) {
  expect(result).not.toHaveProperty('isError', true);
  return result.structuredContent!;
}

async function pendingPurchase(kind: 'catalog' | 'lot') {
  if (kind === 'catalog') {
    const { rows: [product] } = await db.pool.query(`INSERT INTO commerce.products
      (environment,product_code,product_name,product_type)
      VALUES ('test',$1,'Pneu fictício','tire') RETURNING id`, [randomUUID()]);
    await db.pool.query(`INSERT INTO commerce.tire_specs
      (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
      VALUES ('test',$1,'215/50-16',215,50,16)`, [product.id]);
  }
  const { rows: [supplier] } = await db.pool.query(`INSERT INTO commerce.wholesale_suppliers(environment,name)
    VALUES('test',$1) RETURNING id`, [`Fornecedor fictício ${kind}`]);
  const { purchase_id } = await purchases.registerWholesalePurchase({
    environment: 'test', supplier_id: supplier.id,
    items: kind === 'catalog' ? [{ measure: '215/50-16', tire_condition: 'meia_vida', quantity: 10, unit_cost: 150 }] : [],
    ...(kind === 'lot' ? { lot: { description: 'Lote fictício', quantity: 10, total_cost: 1500 } } : {}),
    purchased_at: '2026-10-05T15:00:00Z', receipt_status: 'pending', payment_status: 'pending',
    due_date: '2026-12-01', created_by: 'Dono teste', idempotency_key: randomUUID(),
  }, db.pool);
  return { purchase_id, supplier_id: supplier.id };
}

async function configure(mode: 'conversa' | 'painel', enabled: boolean) {
  await db.pool.query(`UPDATE network.dot_oauth_grants SET operation_confirmation=$2,purchase_receipt_enabled=$3
    WHERE environment='test' AND id=$1`, [identity.grant_id, mode, enabled]);
}

async function receiptState(purchaseId: string) {
  return (await db.pool.query(`SELECT p.status,p.total_amount,p.stock_applied,
    (SELECT count(*)::int FROM finance.matriz_ledger_transactions
      WHERE environment=p.environment AND source_type='commerce.wholesale_purchase.receipt' AND source_id=p.id::text) receipts
    FROM commerce.wholesale_purchases p WHERE p.environment='test' AND p.id=$1`, [purchaseId])).rows[0];
}

it('exige aval por voz e recebe quantidades conferidas na compra original uma única vez', async () => {
  expect(server.listedDotTools().map(tool => tool.name)).toEqual(expect.arrayContaining([lookup, receipt]));
  const { purchase_id } = await pendingPurchase('catalog');
  const candidate = contents(await call(lookup, { compra_id: purchase_id }));
  expect(candidate).toMatchObject({ compra: { compra_id: purchase_id, status: 'pending', valor_brl: 1500 },
    itens: [expect.objectContaining({ measure: '215/50-16', ordered_quantity: 10 })] });
  const [{ id: item_id }] = candidate.itens as Array<{ id: string }>;
  const args = { compra_id: purchase_id, revisao: candidate.revisao, idempotency_key: randomUUID(),
    items: [{ item_id, accepted_quantity: 4 }] };

  await configure('conversa', false);
  expect(await call(receipt, args)).toMatchObject({ isError: true });
  await configure('painel', true);
  expect(await call(receipt, args)).toMatchObject({ isError: true });
  await configure('conversa', true);
  const proposal = contents(await call(receipt, args));
  expect(proposal).toMatchObject({ status: 'aguardando_autorizacao', executada: false,
    confirmacao: 'conversa', autorizacao_exigida: 'voz',
    dados: { efeitos: { valor_apos_recebimento_brl: 600, itens_aceitos: [{ id: item_id, accepted_quantity: 4 }] } } });
  expect(proposal).not.toHaveProperty('confirm_url');
  const decision = { proposta: proposal.proposta, fingerprint: proposal.fingerprint, autorizado_pelo_dono: true };
  expect(await call('confirmar_operacao_milly', decision)).toMatchObject({ isError: true });
  const { ownerReview } = await import('../../src/admin/dot/operation-reviews.js');
  await expect(ownerReview(identity.person_id, proposal.proposta as string, 'autorizada')).rejects.toThrow('dot_confirmation_channel_disabled');
  expect(await receiptState(purchase_id)).toMatchObject({ status: 'pending', stock_applied: false, receipts: 0 });

  const authorization = contents(await call('confirmar_operacao_milly', { ...decision, canal_autorizacao: 'voz' }));
  expect(authorization).toMatchObject({ status: 'autorizada', executada: false });
  const [first, retry] = await Promise.all([call(receipt, args), call(receipt, args)]);
  expect(contents(first)).toMatchObject({ status: 'executada', executada: true,
    resultado: { purchase_id, stock_applied: true } });
  expect(contents(retry)).toEqual(contents(first));
  expect(await receiptState(purchase_id)).toEqual({ status: 'confirmed', total_amount: '600.00', stock_applied: true, receipts: 1 });
  const line = await db.pool.query(`SELECT accepted_quantity FROM commerce.wholesale_purchase_items
    WHERE environment='test' AND id=$1`, [item_id]);
  expect(line.rows).toEqual([{ accepted_quantity: 4 }]);
  const stock = await db.pool.query(`SELECT quantity_on_hand FROM commerce.wholesale_stock
    WHERE environment='test' AND measure='215/50-16'`);
  expect(stock.rows).toEqual([{ quantity_on_hand: 4 }]);
  expect(await call(lookup, { compra_id: purchase_id })).toMatchObject({ isError: true });
});

it('recusa lote parcial e revalida a ficha depois da autorização', async () => {
  await configure('conversa', true);
  const { purchase_id, supplier_id } = await pendingPurchase('lot');
  const candidate = contents(await call(lookup, { compra_id: purchase_id }));
  const [{ id: item_id }] = candidate.itens as Array<{ id: string }>;
  const args = { compra_id: purchase_id, revisao: candidate.revisao, idempotency_key: randomUUID() };
  expect(await call(receipt, { ...args, items: [{ item_id, accepted_quantity: 4 }] })).toMatchObject({ isError: true });
  const proposal = contents(await call(receipt, args));
  contents(await call('confirmar_operacao_milly', { proposta: proposal.proposta,
    fingerprint: proposal.fingerprint, autorizado_pelo_dono: true, canal_autorizacao: 'voz' }));
  await db.pool.query(`UPDATE commerce.wholesale_suppliers SET name='Fornecedor corrigido'
    WHERE environment='test' AND id=$1`, [supplier_id]);
  const outdated = await call(receipt, args);
  expect(outdated).toMatchObject({ isError: true });
  expect(outdated.content[0]).toMatchObject({ text: expect.stringContaining('compra_alterada_consulte_novamente') });
  expect(await receiptState(purchase_id)).toMatchObject({ status: 'pending', stock_applied: false, receipts: 0 });

  const updated = contents(await call(lookup, { compra_id: purchase_id }));
  const replacement = { ...args, revisao: updated.revisao, idempotency_key: randomUUID() };
  const secondProposal = contents(await call(receipt, replacement));
  contents(await call('confirmar_operacao_milly', { proposta: secondProposal.proposta,
    fingerprint: secondProposal.fingerprint, autorizado_pelo_dono: true, canal_autorizacao: 'voz' }));
  expect(contents(await call(receipt, replacement))).toMatchObject({ executada: true });
  expect(await receiptState(purchase_id)).toMatchObject({ status: 'confirmed', stock_applied: true, receipts: 1 });
  const { rows } = await db.pool.query(`SELECT quantity_on_hand,remaining_cost FROM commerce.tire_lots
    WHERE environment='test' AND purchase_id=$1`, [purchase_id]);
  expect(rows).toEqual([{ quantity_on_hand: 10, remaining_cost: '1500.00' }]);
});
