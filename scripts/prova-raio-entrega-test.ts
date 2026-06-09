/**
 * Prova de round-trip do RAIO DE ENTREGA (proximidade-primeiro Fase 2).
 *
 * Cria um parceiro ISOLADO no env TEST, grava e relê o raio pelas funções REAIS
 * do painel (updatePartnerAtendimento + getPartnerConfiguracoes), assere o
 * comportamento e LIMPA tudo no fim (sem deixar lixo no banco test).
 *
 * Regras provadas:
 *   1. Faz entrega + raio N  → persiste N (km).
 *   2. Atualiza o raio       → sobrescreve.
 *   3. NÃO faz entrega (pickup) → raio vira NULL (não há o que limitar).
 *   4. Decimal NUMERIC(6,2)  → preserva 2 casas.
 *
 *   npx tsx --env-file=.env scripts/prova-raio-entrega-test.ts
 */
import { Pool } from 'pg';
import { createPartnerFixture, type PartnerFixture } from '../tests/integration/helpers/partner-fixtures.js';
import { updatePartnerAtendimento, getPartnerConfiguracoes } from '../src/parceiro/queries.js';
import type { PartnerContext } from '../src/parceiro/auth.js';

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
  console.log('Prova: raio de entrega (Fase 2) — round-trip real no banco test\n');

  const fx = await createPartnerFixture(pool);
  const ctx = fx.ctx as PartnerContext;
  try {
    // 1. Faz entrega com raio 8.5 km
    await updatePartnerAtendimento(ctx, 'delivery', 8.5);
    let cfg = await getPartnerConfiguracoes(ctx);
    check('1a. grava raio 8.5 em delivery', cfg.loja?.delivery_radius_km === 8.5, cfg.loja?.delivery_radius_km);
    check('1b. faz_entrega=true em delivery', cfg.loja?.faz_entrega === true);

    // 2. Atualiza o raio (both, 12 km)
    await updatePartnerAtendimento(ctx, 'both', 12);
    cfg = await getPartnerConfiguracoes(ctx);
    check('2. sobrescreve raio p/ 12 em both', cfg.loja?.delivery_radius_km === 12, cfg.loja?.delivery_radius_km);

    // 3. Não faz entrega (pickup) → raio NULL
    await updatePartnerAtendimento(ctx, 'pickup', null);
    cfg = await getPartnerConfiguracoes(ctx);
    check('3a. zera raio (NULL) em pickup', cfg.loja?.delivery_radius_km === null, cfg.loja?.delivery_radius_km);
    check('3b. faz_entrega=false em pickup', cfg.loja?.faz_entrega === false);

    // 4. Decimal NUMERIC(6,2) preserva 2 casas
    await updatePartnerAtendimento(ctx, 'delivery', 7.25);
    cfg = await getPartnerConfiguracoes(ctx);
    check('4. preserva decimal 7.25', cfg.loja?.delivery_radius_km === 7.25, cfg.loja?.delivery_radius_km);
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
