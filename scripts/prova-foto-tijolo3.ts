/**
 * Prova de integração — Tijolo 3 da foto sob demanda (lado bot).
 * Chama o createPhotoRequest REAL (módulo TS) num BEGIN/ROLLBACK no env test:
 * caminho feliz, dedup (LLM chamou 2x ≠ 2 cards) e limite anti-flood (E18).
 * pg_notify é transacional → o ROLLBACK descarta até a notificação. Nada persiste.
 *
 * Uso: npx tsx --env-file=.env scripts/prova-foto-tijolo3.ts
 */
import { pool } from '../src/persistence/db.js';
import { createPhotoRequest } from '../src/atendente-v2/photo-requests.js';

let passed = 0;
let failed = 0;
function ok(nome: string, cond: boolean, detalhe?: string): void {
  if (cond) { passed++; console.log(`PASS | ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
  else { failed++; console.log(`FAIL | ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const unit = await client.query<{ unit_id: string; slug: string }>(
      `SELECT unit_id, slug FROM network.partner_units WHERE environment = 'test' ORDER BY created_at LIMIT 1`,
    );
    if (unit.rowCount !== 1) throw new Error('nenhuma partner_unit no env test');
    const unitId = unit.rows[0]!.unit_id;
    console.log(`unidade de teste: ${unit.rows[0]!.slug}\n`);

    const conv = 555001; // chatwoot_conversation_id fake (BIGINT)

    // 1. Caminho feliz
    const r1 = await createPhotoRequest(client, 'test', {
      unitId, chatwootConversationId: conv, tireSize: 'Pneu 140/70-17 (PROVA T3)', brand: 'Pirelli',
    });
    ok('cria pedido (created, prazo 10min)', r1.status === 'created' && r1.prazoMin === 10);

    // 2. Dedup: mesma conversa + mesma loja + mesmo pneu pendente → devolve o existente
    const r2 = await createPhotoRequest(client, 'test', {
      unitId, chatwootConversationId: conv, tireSize: 'Pneu 140/70-17 (PROVA T3)', brand: 'Pirelli',
    });
    ok('dedup: 2ª chamada devolve o MESMO card', r2.status === 'dedup'
      && r1.status === 'created' && r2.photoRequestId === r1.photoRequestId);

    // 3. Segundo pneu na mesma conversa: cria (2 ativos = teto)
    const r3 = await createPhotoRequest(client, 'test', {
      unitId, chatwootConversationId: conv, tireSize: 'Pneu 90/90-18 (PROVA T3)', brand: null,
    });
    ok('segundo pneu cria card novo (2/2)', r3.status === 'created');

    // 4. Terceiro pedido: limite (máx 2 ativos por conversa — E18 anti-flood)
    const r4 = await createPhotoRequest(client, 'test', {
      unitId, chatwootConversationId: conv, tireSize: 'Pneu 100/90-10 (PROVA T3)', brand: null,
    });
    ok('terceiro pedido barrado (limit)', r4.status === 'limit');

    // 5. Outra conversa não é afetada pelo limite da primeira
    const r5 = await createPhotoRequest(client, 'test', {
      unitId, chatwootConversationId: 555002, tireSize: 'Pneu 100/90-10 (PROVA T3)', brand: null,
    });
    ok('outra conversa cria normal (limite é POR conversa)', r5.status === 'created');

    // 6. Estado no banco: 3 pending desta prova
    const count = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM commerce.photo_requests
        WHERE environment = 'test' AND conversation_id IN (555001, 555002) AND status = 'pending'`,
    );
    ok('3 cards pending no banco (dentro da transação)', Number(count.rows[0]!.n) === 3);

    console.log(`\n${passed} PASS / ${failed} FAIL`);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
    console.log('ROLLBACK — nada persistiu (nem o pg_notify, que é transacional).');
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`ERRO: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
