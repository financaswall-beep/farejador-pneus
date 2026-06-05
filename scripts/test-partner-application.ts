/**
 * Teste do fluxo Etapa 3 (candidatura pública → fila → aprovar → vira parceiro).
 * Cria em prod com dado de teste e LIMPA tudo no fim.
 *   npx tsx --env-file=.env scripts/test-partner-application.ts
 */
import { pool } from '../src/persistence/db.js';
import { env } from '../src/shared/config/env.js';
import {
  createPartnerApplication, listPartnerApplications, approvePartnerApplication,
} from '../src/admin/painel/queries.js';

let falhas = 0;
const check = (n: string, ok: boolean, d = ''): void => {
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  →  ' + d : ''}`);
  if (!ok) falhas++;
};

async function main(): Promise<void> {
  const client = await pool.connect();
  let appId: string | undefined;
  let created: Awaited<ReturnType<typeof approvePartnerApplication>> | undefined;
  try {
    const app = await createPartnerApplication({
      trade_name: 'Teste Candidatura SG', responsible_name: 'Beltrano Teste',
      whatsapp_phone: '+5521988887777', municipios: 'São Gonçalo', message: 'quero entrar na rede',
    });
    appId = app.id;
    check('1. candidatura criada (público)', !!appId, appId);

    const fila = await listPartnerApplications('pending') as Array<{ id: string }>;
    check('2. aparece na fila de pendentes', fila.some((a) => a.id === appId));

    created = await approvePartnerApplication({
      application_id: appId, actor_label: 'test:etapa3',
      municipios: ['São Gonçalo'], commission_percent: 12,
    });
    check('3. aprovou e criou o parceiro', created.already_exists === false && !!created.partner_id);
    check('4. parceiro nasce com login (token)', typeof created.token === 'string' && created.token!.length === 64);

    const all = await listPartnerApplications('all') as Array<{ id: string; status: string; created_partner_unit_id: string | null }>;
    const row = all.find((a) => a.id === appId);
    check('5. candidatura virou approved + linkada', row?.status === 'approved' && row?.created_partner_unit_id === created.partner_unit_id);

    const v = await client.query(`SELECT * FROM network.validate_partner_token($1,$2,$3)`, [env.FAREJADOR_ENV, created.slug, created.token]);
    check('6. login do parceiro funciona', v.rowCount === 1);
  } finally {
    if (created?.unit_id) {
      await client.query(`DELETE FROM network.unit_coverage WHERE unit_id=$1`, [created.unit_id]);
      await client.query(`DELETE FROM network.partner_access_tokens WHERE partner_unit_id=$1`, [created.partner_unit_id]);
      await client.query(`DELETE FROM network.partner_units WHERE id=$1`, [created.partner_unit_id]);
      await client.query(`DELETE FROM network.partners WHERE id=$1`, [created.partner_id]);
      await client.query(`DELETE FROM core.units WHERE id=$1`, [created.unit_id]);
    }
    if (appId) await client.query(`DELETE FROM network.partner_applications WHERE id=$1`, [appId]);
    console.log('— cleanup: candidatura e parceiro de teste removidos —');
    client.release();
    await pool.end();
  }
  console.log(falhas === 0 ? '\n=== TUDO VERDE ✅ ===' : `\n=== ${falhas} FALHA(S) ❌ ===`);
  process.exit(falhas === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
