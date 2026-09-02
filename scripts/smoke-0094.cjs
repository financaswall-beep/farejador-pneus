'use strict';
// Smoke de integração da 0094 (photo_requests) — BEGIN/ROLLBACK TOTAL, env test.
// PARTNER_DATABASE_URL não existe local → GRANT farejador_partner_app TO postgres
// DENTRO da transação (transacional; o ROLLBACK desfaz o grant junto com os dados).
// SET ROLE simula a role restrita do painel com RLS efetiva. Nada persiste.
// Uso: node --env-file=.env scripts/smoke-0094.cjs   (untracked, padrão da casa)

const { Client } = require('pg');

if (process.env.FAREJADOR_ENV !== 'test') {
  console.error('ABORTADO: o smoke 0094 só pode rodar com FAREJADOR_ENV=test.');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL ausente.');
  process.exit(2);
}

let passed = 0;
let failed = 0;
const ok = (nome, cond, detalhe) => {
  if (cond) { passed++; console.log(`PASS | ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
  else { failed++; console.log(`FAIL | ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
};

async function expectError(client, nome, fn, errFragment) {
  await client.query('SAVEPOINT sp');
  try {
    await fn();
    ok(nome, false, 'NAO deu erro (deveria)');
  } catch (err) {
    const hit = errFragment ? String(err.message).includes(errFragment) : true;
    ok(nome, hit, err.message.slice(0, 90));
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT sp');
  }
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query('BEGIN');

  try {
    // Habilita SET ROLE só dentro desta transação (rollback desfaz).
    await client.query('GRANT farejador_partner_app TO postgres');

    const asPartner = async (partnerUnitId) => {
      await client.query("SELECT set_config('app.partner_unit_id', $1, true)", [partnerUnitId]);
      await client.query('SET ROLE farejador_partner_app');
    };
    const asBot = async () => { await client.query('RESET ROLE'); };

    // ── Setup: 2 unidades parceiras do env TEST ──
    const units = await client.query(`
      SELECT pu.id AS partner_unit_id, pu.unit_id, pu.slug
      FROM network.partner_units pu
      WHERE pu.environment = 'test'
      ORDER BY pu.created_at
      LIMIT 2
    `);
    if (units.rowCount === 0) throw new Error('nenhuma partner_unit no env test');
    const u1 = units.rows[0];
    const u2 = units.rows[1] ?? null;
    console.log(`unidade A: ${u1.slug} | unidade B: ${u2 ? u2.slug : '(GUC aleatorio)'}\n`);

    const jpegFake = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

    // ── 1. Bot cria o pedido de foto ──
    const ins = await client.query(
      `INSERT INTO commerce.photo_requests
         (environment, unit_id, conversation_id, tire_size, brand, note)
       VALUES ('test', $1, 999999, '140/70-17', 'Pirelli', 'meia-vida (SMOKE 0094)')
       RETURNING id, status, expires_at > now() AS prazo_futuro`,
      [u1.unit_id],
    );
    const reqId = ins.rows[0].id;
    ok('bot cria photo_request (pending)', ins.rows[0].status === 'pending');
    ok('expires_at default +10min', ins.rows[0].prazo_futuro === true);

    // ── 2. PARCEIRO da unidade A ──
    await asPartner(u1.partner_unit_id);

    const fila = await client.query(
      'SELECT id, tire_size, status, has_photo FROM commerce.partner_photo_queue WHERE id = $1',
      [reqId],
    );
    ok('parceiro ve o card na view', fila.rowCount === 1 && fila.rows[0].has_photo === false);

    await expectError(client, 'parceiro NAO le conversation_id (negado por coluna)', () =>
      client.query('SELECT conversation_id FROM commerce.photo_requests WHERE id = $1', [reqId]),
      'permission denied');

    await expectError(client, 'parceiro NAO cria photo_request (negado)', () =>
      client.query(
        `INSERT INTO commerce.photo_requests (environment, unit_id, conversation_id, tire_size)
         VALUES ('test', $1, 123, '90/90-18')`,
        [u1.unit_id],
      ),
      'permission denied');

    const at1 = await client.query(
      'SELECT * FROM commerce.attach_partner_photo($1, $2, $3, $4)',
      [reqId, jpegFake, 'image/jpeg', jpegFake.length],
    );
    ok('attach 1: anexa e vira answered',
      at1.rows[0].out_attached === true && at1.rows[0].out_status === 'answered' && at1.rows[0].out_was_late === false);

    const at2 = await client.query(
      'SELECT * FROM commerce.attach_partner_photo($1, $2, $3, $4)',
      [reqId, jpegFake, 'image/jpeg', jpegFake.length],
    );
    ok('attach 2 (duplo-clique): no-op', at2.rows[0].out_attached === false && at2.rows[0].out_status === 'answered');

    const img = await client.query(
      'SELECT photo_mime, length(photo_bytes) AS len FROM commerce.photo_request_blobs WHERE photo_request_id = $1',
      [reqId],
    );
    ok('parceiro le os bytes da propria foto', img.rowCount === 1 && Number(img.rows[0].len) === jpegFake.length);

    const fila2 = await client.query('SELECT has_photo, status FROM commerce.partner_photo_queue WHERE id = $1', [reqId]);
    ok('view reflete has_photo=true + answered', fila2.rows[0].has_photo === true && fila2.rows[0].status === 'answered');

    // MIME proibido (pedido novo só pra isso)
    await asBot();
    const insMime = await client.query(
      `INSERT INTO commerce.photo_requests (environment, unit_id, conversation_id, tire_size)
       VALUES ('test', $1, 888888, '90/90-18') RETURNING id`,
      [u1.unit_id],
    );
    const mimeId = insMime.rows[0].id;
    await asPartner(u1.partner_unit_id);
    await expectError(client, 'attach com image/svg+xml (negado pela function)', () =>
      client.query('SELECT * FROM commerce.attach_partner_photo($1, $2, $3, $4)',
        [mimeId, jpegFake, 'image/svg+xml', jpegFake.length]),
      'MIME nao permitido');

    // ── 3. OUTRA unidade não vê nem mexe ──
    await asBot();
    const otherGuc = u2 ? u2.partner_unit_id : '00000000-0000-0000-0000-000000000000';
    await asPartner(otherGuc);

    const fila3 = await client.query('SELECT 1 FROM commerce.partner_photo_queue WHERE id = $1', [reqId]);
    ok('outra unidade NAO ve o card (RLS)', fila3.rowCount === 0);

    const img2 = await client.query('SELECT 1 FROM commerce.photo_request_blobs WHERE photo_request_id = $1', [reqId]);
    ok('outra unidade NAO le o blob alheio (RLS)', img2.rowCount === 0);

    await expectError(client, 'outra unidade NAO anexa no card alheio', () =>
      client.query('SELECT * FROM commerce.attach_partner_photo($1, $2, $3, $4)',
        [reqId, jpegFake, 'image/jpeg', jpegFake.length]),
      'nao encontrado');

    // ── 4. Expirador + foto atrasada ──
    await asBot();
    const insLate = await client.query(
      `INSERT INTO commerce.photo_requests
         (environment, unit_id, conversation_id, tire_size, expires_at)
       VALUES ('test', $1, 777777, '100/90-10', now() - interval '1 minute')
       RETURNING id`,
      [u1.unit_id],
    );
    const lateId = insLate.rows[0].id;
    const exp = await client.query(
      `UPDATE commerce.photo_requests SET status = 'expired'
        WHERE status = 'pending' AND expires_at < now() AND id = $1
        RETURNING id`,
      [lateId],
    );
    ok('expirador marca expired (UPDATE...RETURNING)', exp.rowCount === 1);

    await asPartner(u1.partner_unit_id);
    const atLate = await client.query(
      'SELECT * FROM commerce.attach_partner_photo($1, $2, $3, $4)',
      [lateId, jpegFake, 'image/jpeg', jpegFake.length],
    );
    ok('foto atrasada: anexa em expired -> answered + was_late',
      atLate.rows[0].out_attached === true && atLate.rows[0].out_was_late === true);

    // ── 5. Guard de migração pro item (unit divergente não casa) ──
    await asBot();
    const divergente = await client.query(
      `UPDATE commerce.photo_requests pr
          SET order_item_id = NULL
        FROM commerce.partner_orders po
        WHERE pr.id = $1
          AND po.unit_id <> pr.unit_id
          AND po.environment = pr.environment
        RETURNING pr.id`,
      [reqId],
    );
    ok('guard re-roteamento: UPDATE com unit divergente nao casa', divergente.rowCount === 0);

    console.log(`\n${passed} PASS / ${failed} FAIL`);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
    console.log('ROLLBACK total — nada persistiu (nem o GRANT).');
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`ERRO: ${err.message}`);
  process.exit(1);
});
