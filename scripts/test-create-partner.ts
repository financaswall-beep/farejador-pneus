/**
 * Teste do createPartnerUnit (Etapa 1 onboarding) — cria parceiro fake no ambiente TEST
 * (isolado do prod), valida login + cobertura + segurança, e LIMPA tudo no fim.
 *   npx tsx --env-file=.env scripts/test-create-partner.ts
 */
import { pool } from '../src/persistence/db.js';
import { createPartnerUnit } from '../src/admin/painel/queries.js';
import { resolveUnitForMunicipio } from '../src/atendente-v2/fulfillment.js';

const ENV = 'test' as const;
let falhas = 0;
const check = (n: string, ok: boolean, d = ''): void => {
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  →  ' + d : ''}`);
  if (!ok) falhas++;
};

async function main(): Promise<void> {
  const client = await pool.connect();
  let created: Awaited<ReturnType<typeof createPartnerUnit>> | undefined;
  try {
    created = await createPartnerUnit({
      environment: ENV,
      trade_name: 'Teste Onboarding Niteroi',
      responsible_name: 'Fulano Teste',
      whatsapp_phone: '+5521999990000',
      commission_percent: 10,
      municipios: ['Niterói'],
      actor_label: 'test:onboarding',
    });
    console.log('criado:', JSON.stringify(created));

    check('1. criou (already_exists=false)', created.already_exists === false);
    check('2. devolveu token (login)', typeof created.token === 'string' && created.token.length === 64);
    check('3. slug gerado do nome', created.slug === 'teste-onboarding-niteroi', created.slug);

    const v = await client.query(`SELECT * FROM network.validate_partner_token($1,$2,$3)`, [ENV, created.slug, created.token]);
    check('4. login VÁLIDO com o token', v.rowCount === 1, JSON.stringify(v.rows[0] ?? null));

    const bad = await client.query(`SELECT * FROM network.validate_partner_token($1,$2,$3)`, [ENV, created.slug, 'token-errado-123']);
    check('5. token ERRADO bloqueado', bad.rowCount === 0);

    const ctx = await resolveUnitForMunicipio(client, ENV, 'Niterói');
    check('6. cobertura roteia Niterói pro parceiro novo', ctx?.slug === created.slug, ctx?.slug ?? 'null');

    const role = await client.query(`SELECT role FROM network.partner_access_tokens WHERE partner_unit_id=$1`, [created.partner_unit_id]);
    check('7. token nasce com role=owner', role.rows[0]?.role === 'owner', role.rows[0]?.role ?? 'null');
  } finally {
    if (created?.unit_id) {
      await client.query(`DELETE FROM network.unit_coverage WHERE unit_id=$1 AND environment=$2`, [created.unit_id, ENV]);
      await client.query(`DELETE FROM network.partner_access_tokens WHERE partner_unit_id=$1 AND environment=$2`, [created.partner_unit_id, ENV]);
      await client.query(`DELETE FROM network.partner_units WHERE id=$1 AND environment=$2`, [created.partner_unit_id, ENV]);
      await client.query(`DELETE FROM network.partners WHERE id=$1 AND environment=$2`, [created.partner_id, ENV]);
      await client.query(`DELETE FROM core.units WHERE id=$1 AND environment=$2`, [created.unit_id, ENV]);
      console.log('— cleanup: parceiro de teste removido (nada persistiu) —');
    }
    client.release();
    await pool.end();
  }
  console.log(falhas === 0 ? '\n=== TUDO VERDE ✅ ===' : `\n=== ${falhas} FALHA(S) ❌ ===`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
