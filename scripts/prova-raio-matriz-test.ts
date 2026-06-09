/**
 * Prova do RAIO DE ENTREGA definido pela MATRIZ (proximidade-primeiro Fase 2).
 *
 * Cria um parceiro ISOLADO no env TEST, define/lê o raio pelas funções REAIS da
 * matriz (setPartnerUnitDeliveryRadius + getPainelRede), assere e LIMPA no fim.
 *
 * Regras provadas:
 *   1. Parceiro que faz entrega (both) → matriz define o raio → persiste e aparece na getPainelRede.
 *   2. Limpar (null) → volta a NULL.
 *   3. Parceiro só-retirada (pickup) → matriz NÃO consegue definir raio (reason pickup_only), valor intocado.
 *
 *   npx tsx --env-file=.env scripts/prova-raio-matriz-test.ts
 */
import { Pool } from 'pg';
import { createPartnerFixture, type PartnerFixture } from '../tests/integration/helpers/partner-fixtures.js';
import { setPartnerUnitDeliveryRadius, getPainelRede } from '../src/admin/painel/queries.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let ok = 0;
let fail = 0;
function check(label: string, cond: boolean, got?: unknown): void {
  if (cond) {
    ok++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${got !== undefined ? ` (recebeu: ${JSON.stringify(got)})` : ''}`);
  }
}

async function radiusOnRede(partnerUnitId: string): Promise<number | null | undefined> {
  const rows = (await getPainelRede('month', pool)) as Array<{ partner_unit_id: string; delivery_radius_km: string | null }>;
  const row = rows.find((r) => r.partner_unit_id === partnerUnitId);
  if (!row) return undefined;
  return row.delivery_radius_km === null ? null : Number(row.delivery_radius_km);
}

async function setMode(partnerUnitId: string, mode: 'both' | 'pickup'): Promise<void> {
  await pool.query(`UPDATE network.partner_units SET service_mode = $2 WHERE id = $1`, [partnerUnitId, mode]);
}

async function cleanup(fx: PartnerFixture): Promise<void> {
  await pool.query(`DELETE FROM commerce.partner_stock_levels WHERE id = $1`, [fx.stockId]);
  await pool.query(`DELETE FROM network.partner_access_tokens WHERE id = $1`, [fx.tokenId]);
  await pool.query(`DELETE FROM network.partner_units WHERE id = $1`, [fx.partnerUnitId]);
  await pool.query(`DELETE FROM network.partners WHERE id = $1`, [fx.partnerId]);
  await pool.query(`DELETE FROM core.units WHERE id = $1`, [fx.unitId]);
}

async function main(): Promise<void> {
  if (process.env.FAREJADOR_ENV !== 'test') {
    throw new Error('Rode com env test (FAREJADOR_ENV=test no .env). Abortado por segurança.');
  }
  console.log('Prova: raio de entrega definido pela MATRIZ (Fase 2) — round-trip real no banco test\n');

  const fx = await createPartnerFixture(pool);
  const puId = fx.partnerUnitId;
  try {
    // 1. faz entrega (both) → matriz define raio 9
    await setMode(puId, 'both');
    const r1 = await setPartnerUnitDeliveryRadius('test', puId, 9, pool);
    check('1a. setter aceita raio em parceiro que faz entrega', r1.updated === true, r1);
    check('1b. getPainelRede mostra raio 9', (await radiusOnRede(puId)) === 9, await radiusOnRede(puId));

    // 2. limpar (null)
    const r2 = await setPartnerUnitDeliveryRadius('test', puId, null, pool);
    check('2a. setter limpa o raio', r2.updated === true, r2);
    check('2b. getPainelRede mostra NULL', (await radiusOnRede(puId)) === null, await radiusOnRede(puId));

    // 3. só retirada (pickup) → setter NÃO define (respeita autonomia)
    await setMode(puId, 'pickup');
    const r3 = await setPartnerUnitDeliveryRadius('test', puId, 5, pool);
    check('3a. setter recusa raio em parceiro só-retirada', r3.updated === false && r3.reason === 'pickup_only', r3);
    check('3b. raio segue NULL (não forçou entrega)', (await radiusOnRede(puId)) === null, await radiusOnRede(puId));
  } finally {
    await cleanup(fx);
    await pool.end();
  }

  console.log(`\n${fail === 0 ? '✅ PASSOU' : '❌ FALHOU'} — ${ok} ok / ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('Erro na prova:', e);
  try { await pool.end(); } catch { /* noop */ }
  process.exit(1);
});
