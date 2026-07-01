// Prova: TRAVA DE OVERSELL da matriz no varejo (Camada 1b) — checkMatrizGalpaoShortfall
// contra o schema REAL. PROD com BEGIN/ROLLBACK (não grava nada).
// rodar: npx tsx --env-file=.env.preview.pooler scripts/prova-oversell-guard-matriz-test.ts
import { pool } from '../src/persistence/db.js';
import { checkMatrizGalpaoShortfall } from '../src/atendente-v2/wholesale-stock-read.js';

const PROD_90_90_12 = 'fa071d85-f7d6-41de-b22b-5a1b002eca84'; // produto cujo tire_size é 90/90-12

let fails = 0;
function check(label: string, cond: boolean, extra = ''): void {
  console.log(`  [${cond ? 'OK ' : 'XX '}] ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) fails++;
}

async function main(): Promise<void> {
  const env = 'prod' as const;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // cenário controlado: galpão 90/90-12 = 3 (dentro da transação; rollback desfaz)
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure='90/90-12'`, [env]);
    await client.query(
      `INSERT INTO commerce.wholesale_stock
         (environment, measure, quantity_on_hand, tire_width_mm, tire_aspect_ratio, tire_rim_diameter, unit_cost)
       VALUES ($1, '90/90-12', 3, 90, 90, 12, 0)`,
      [env],
    );
    console.log('=== PROVA TRAVA OVERSELL MATRIZ (prod, rollback) ===');
    console.log('  setup: galpão 90/90-12 = 3\n');

    const f5 = await checkMatrizGalpaoShortfall(client, env, [{ productId: PROD_90_90_12, quantity: 5 }]);
    check('1 pede 5 (tem 3): TRAVA (1 falta)', f5.length === 1, JSON.stringify(f5));
    check('1b falta traz disponível 3 e pedido 5', f5[0]?.available === 3 && f5[0]?.requested === 5);

    const f3 = await checkMatrizGalpaoShortfall(client, env, [{ productId: PROD_90_90_12, quantity: 3 }]);
    check('2 pede 3 (tem 3): passa (sem falta)', f3.length === 0, JSON.stringify(f3));

    const f2 = await checkMatrizGalpaoShortfall(client, env, [{ productId: PROD_90_90_12, quantity: 2 }]);
    check('3 pede 2 (tem 3): passa (sem falta)', f2.length === 0);

    // galpão zera → qualquer pedido falta (não vende do vazio)
    await client.query(`UPDATE commerce.wholesale_stock SET quantity_on_hand = 0 WHERE environment=$1 AND measure='90/90-12'`, [env]);
    const fZero = await checkMatrizGalpaoShortfall(client, env, [{ productId: PROD_90_90_12, quantity: 1 }]);
    check('4 galpão 0, pede 1: TRAVA (disponível 0)', fZero.length === 1 && fZero[0]?.available === 0);

    await client.query('ROLLBACK');
    console.log(`\n${fails === 0 ? '✅ TRAVA PROVADA' : `❌ ${fails} FALHA(S)`} — ROLLBACK, nada gravado em prod`);
    if (fails > 0) process.exitCode = 1;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('✗ ERRO:', e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
