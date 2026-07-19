/**
 * PROVA de INTEGRAÇÃO da COMISSÃO COMO LANÇAMENTO (0118), env `test`, chamando o CÓDIGO
 * REAL (sweepCommissionEntries / getCommissionLedger / settleCommissionEntries /
 * updatePartnerCommercialTerms). Prova as 4 regras do dono (2026-07-02):
 *   1. nasce SÓ quando a venda 2W REALIZA (pickup fechado/retirado; entrega entregue);
 *   2. venda cancelada → estorna sozinho (até se já PAGA — trilha preservada);
 *   3. % da ficha CONGELADO no lançamento (mudar a ficha não mexe no passado);
 *   4. porta não paga comissão; varredura é idempotente (rodar 2x não duplica).
 *
 * Rodar: npx tsx --env-file=.env.pooler scripts/prova-comissao-rede-test.ts
 * (as funções não são chaveadas por flag — o gate NETWORK_COMMISSION_LEDGER fica na rota)
 *
 * Usa a loja-fantoche fake-rede-a (test): salva os termos atuais da ficha, opera, e
 * RESTAURA tudo no finally (pedidos, lançamentos e ficha).
 */
import { pool } from '../src/persistence/db.js';
import {
  sweepCommissionEntries,
  getCommissionLedger,
  settleCommissionEntries,
  updatePartnerCommercialTerms,
} from '../src/admin/painel/queries.js';

const ENV = 'test' as const;
const TAG = 'PROVA-COMISSAO-' + Date.now();

interface EntryRow {
  status: string;
  commission_percent: string;
  commission_amount: string;
  settled_at: string | null;
  reversed_at: string | null;
}

async function main(): Promise<void> {
  console.log('=== PROVA COMISSÃO COMO LANÇAMENTO — 0118 (test) ===');
  const client = await pool.connect();
  let fails = 0;
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };
  const orderIds: Record<string, string> = {};
  let partnerId = '';
  let unitId = '';
  let savedTerms: { commercial_model: string; commission_percent: string | null; monthly_fee: string | null } | null = null;

  const entry = async (key: string): Promise<EntryRow | null> => {
    const r = await client.query<EntryRow>(
      `SELECT status, commission_percent, commission_amount, settled_at, reversed_at
         FROM network.commission_entries WHERE environment=$1 AND partner_order_id=$2`,
      [ENV, orderIds[key]]);
    return r.rows[0] ?? null;
  };
  const insertOrder = async (key: string, opts: {
    source_tag: string; total: number; mode?: 'pickup' | 'delivery'; status?: string;
    delivery_status?: string; awaiting_pickup?: boolean; freight?: number;
  }): Promise<void> => {
    const r = await client.query<{ id: string }>(
      `INSERT INTO commerce.partner_orders
         (environment, unit_id, total_amount, status, fulfillment_mode, source_tag,
          customer_name, idempotency_key, freight_amount, delivery_status, awaiting_pickup)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [ENV, unitId, opts.total, opts.status ?? 'confirmed', opts.mode ?? 'pickup', opts.source_tag,
       TAG, TAG + '-' + key, opts.freight ?? 0, opts.delivery_status ?? 'pending', opts.awaiting_pickup ?? false]);
    orderIds[key] = r.rows[0]!.id;
  };

  try {
    // setup: fake-rede-a com ficha comissão 10% (termos atuais salvos pra restaurar)
    const pu = await client.query<{ partner_id: string; unit_id: string }>(
      `SELECT pu.partner_id, pu.unit_id FROM network.partner_units pu
        JOIN core.units u ON u.id = pu.unit_id AND u.environment = pu.environment
       WHERE pu.environment=$1 AND u.slug='fake-rede-a' AND pu.deleted_at IS NULL LIMIT 1`, [ENV]);
    if (!pu.rows[0]) throw new Error('fake-rede-a sem partner_unit no env test');
    partnerId = pu.rows[0].partner_id;
    unitId = pu.rows[0].unit_id;
    const t = await client.query(
      `SELECT commercial_model, commission_percent, monthly_fee FROM network.partners WHERE id=$1 AND environment=$2`,
      [partnerId, ENV]);
    savedTerms = t.rows[0] ?? null;
    await client.query(
      `UPDATE network.partners SET commercial_model='commission', commission_percent=10, monthly_fee=NULL WHERE id=$1 AND environment=$2`,
      [partnerId, ENV]);
    // Estádio limpo: rodada anterior pode ter deixado vendas fake ABERTAS (a faxina
    // não pode mais apagar lançamento — 0139 é imutável; ela CANCELA). Cancelar aqui
    // qualquer sobra etiquetada garante o ledger zerado pro fantoche antes dos checks.
    await client.query(
      `UPDATE commerce.partner_orders SET status='cancelled', updated_at=now()
        WHERE environment=$1 AND unit_id=$2 AND status<>'cancelled'
          AND customer_name LIKE 'PROVA-COMISSAO-%'`, [ENV, unitId]);
    check('setup: fake-rede-a com ficha comissão 10% (sobras de prova canceladas)', true);

    // pedidos: o1 2W pickup realizada · o2 PORTA realizada · o3 2W entrega pendente ·
    //          o4 2W cancelada · o5 2W retirada aguardando
    await insertOrder('o1', { source_tag: '2w', total: 200 });
    await insertOrder('o2', { source_tag: 'porta', total: 500 });
    await insertOrder('o3', { source_tag: '2w', total: 300, mode: 'delivery', delivery_status: 'pending' });
    await insertOrder('o4', { source_tag: '2w', total: 400, status: 'cancelled' });
    await insertOrder('o5', { source_tag: '2w', total: 100, awaiting_pickup: true });
    // o6: 2W realizada COM frete (total 309,90 = 300 de pneu + 9,90 de frete)
    await insertOrder('o6', { source_tag: '2w', total: 309.9, freight: 9.9 });

    // 1. varredura: SÓ a venda 2W realizada gera lançamento (10% congelado)
    await sweepCommissionEntries(ENV, pool);
    const e1 = await entry('o1');
    check('1 venda 2W realizada GEROU lançamento (10% de 200 = 20,00)',
      e1?.status === 'open' && Number(e1.commission_amount) === 20 && Number(e1.commission_percent) === 10,
      JSON.stringify(e1));
    check('1b venda PORTA não gera (porta não paga comissão)', (await entry('o2')) === null);
    check('1c entrega AINDA NÃO entregue não gera (nasce quando realiza)', (await entry('o3')) === null);
    check('1d venda CANCELADA não gera', (await entry('o4')) === null);
    check('1e retirada AGUARDANDO não gera', (await entry('o5')) === null);
    const e6 = await entry('o6');
    check('1f FRETE fica FORA da base (10% de 300 = 30,00; os 9,90 do frete não pagam comissão)',
      e6 !== null && Number(e6.commission_amount) === 30 && Number(e6.commission_percent) === 10,
      JSON.stringify(e6));

    // 2. idempotência: varrer de novo não duplica
    await sweepCommissionEntries(ENV, pool);
    const dup = await client.query(
      `SELECT COUNT(*)::int AS n FROM network.commission_entries WHERE environment=$1 AND partner_order_id=$2`,
      [ENV, orderIds.o1]);
    check('2 varrer 2x não duplica (UNIQUE por venda)', dup.rows[0].n === 1);

    // 3. % da ficha muda pra 15 → lançamento ANTIGO segue 10 (congelado); venda NOVA pega 15
    await client.query(`UPDATE network.partners SET commission_percent=15 WHERE id=$1 AND environment=$2`, [partnerId, ENV]);
    await client.query(
      `UPDATE commerce.partner_orders SET delivery_status='delivered', delivered_at=now() WHERE environment=$1 AND id=$2`,
      [ENV, orderIds.o3]);
    await sweepCommissionEntries(ENV, pool);
    const e3 = await entry('o3');
    const e1b = await entry('o1');
    check('3 entrega ENTREGUE agora gera (15% de 300 = 45,00 — % novo)',
      e3?.status === 'open' && Number(e3.commission_amount) === 45 && Number(e3.commission_percent) === 15,
      JSON.stringify(e3));
    check('3b lançamento antigo SEGUE 10%/20,00 (congelado — ficha mudou, passado não)',
      Number(e1b?.commission_amount) === 20 && Number(e1b?.commission_percent) === 10);

    // 4. retirada retirada → gera
    await client.query(
      `UPDATE commerce.partner_orders SET awaiting_pickup=false, retrieved_at=now() WHERE environment=$1 AND id=$2`,
      [ENV, orderIds.o5]);
    await sweepCommissionEntries(ENV, pool);
    const e5 = await entry('o5');
    check('4 retirada RETIRADA gera (15% de 100 = 15,00)', e5?.status === 'open' && Number(e5.commission_amount) === 15);

    // 5. ledger: parceiro com 4 em aberto somando 110,00 (20 + 45 + 15 + 30)
    const ledger = await getCommissionLedger(ENV, pool);
    const mine = ledger.partners.find((p) => p.partner_id === partnerId);
    check('5 livro: 4 lançamentos em aberto do parceiro, total 110,00',
      mine !== undefined && mine.open_count === 4 && Number(mine.open_total) === 110, JSON.stringify(mine));

    // 6. Recebi: quita os 4 → nada mais em aberto; quitar de novo barra
    // (stage5: idempotency_key obrigatória; o 6b usa chave DIFERENTE de propósito —
    //  repetir a MESMA chave seria replay e devolveria o resultado antigo, não o erro)
    const settled = await settleCommissionEntries(
      { partner_id: partnerId, settled_by: 'prova-comissao', environment: ENV,
        idempotency_key: TAG + '-settle-1', reason: 'prova: recebimento em maos' }, pool);
    check('6 Recebi: 4 quitados somando 110,00', settled.settled_count === 4 && Number(settled.settled_total) === 110);
    let barrou = false;
    try {
      await settleCommissionEntries(
        { partner_id: partnerId, settled_by: 'prova', environment: ENV,
          idempotency_key: TAG + '-settle-2', reason: 'prova: repeticao' }, pool);
    } catch (err) { barrou = (err as Error).message === 'nothing_open'; }
    check('6b quitar sem nada em aberto → barra (nothing_open)', barrou);
    const replayed = await settleCommissionEntries(
      { partner_id: partnerId, settled_by: 'prova-comissao', environment: ENV,
        idempotency_key: TAG + '-settle-1', reason: 'prova: recebimento em maos' }, pool);
    check('6c repetir a MESMA chave → replay devolve o resultado gravado (não quita de novo)',
      replayed.replayed === true && replayed.settled_count === 4 && Number(replayed.settled_total) === 110);

    // 7. venda cancela DEPOIS de paga → estorna com a trilha do pagamento preservada
    await client.query(`UPDATE commerce.partner_orders SET status='cancelled' WHERE environment=$1 AND id=$2`, [ENV, orderIds.o1]);
    await sweepCommissionEntries(ENV, pool);
    const e1c = await entry('o1');
    check('7 venda cancelada após PAGA → estornada COM settled_at preservado (acerto por fora)',
      e1c?.status === 'reversed' && e1c.settled_at !== null && e1c.reversed_at !== null, JSON.stringify(e1c));

    // 8. editor de termos: valida, grava e deixa trilha na auditoria
    let invalidou = false;
    try {
      await updatePartnerCommercialTerms({ partner_id: partnerId, commercial_model: 'commission', commission_percent: 150, monthly_fee: null, actor_label: 'prova', idempotency_key: TAG + '-terms-1', environment: ENV }, pool);
    } catch (err) { invalidou = (err as Error).message === 'invalid_percent'; }
    check('8 editor: % acima de 100 barra', invalidou);
    let naoachou = false;
    try {
      await updatePartnerCommercialTerms({ partner_id: '00000000-0000-0000-0000-000000000000', commercial_model: 'commission', commission_percent: 10, monthly_fee: null, actor_label: 'prova', idempotency_key: TAG + '-terms-2', environment: ENV }, pool);
    } catch (err) { naoachou = (err as Error).message === 'partner_not_found'; }
    check('8b editor: parceiro inexistente barra', naoachou);
    await updatePartnerCommercialTerms({ partner_id: partnerId, commercial_model: 'hybrid', commission_percent: 12.5, monthly_fee: 250, actor_label: 'prova-comissao', idempotency_key: TAG + '-terms-3', environment: ENV }, pool);
    const after = await client.query(
      `SELECT commercial_model, commission_percent, monthly_fee FROM network.partners WHERE id=$1 AND environment=$2`, [partnerId, ENV]);
    const audit = await client.query(
      `SELECT COUNT(*)::int AS n FROM audit.events WHERE environment=$1 AND event_type='partner_terms_updated' AND entity_id=$2`,
      [ENV, partnerId]);
    check('8c editor grava a ficha (hybrid, 12.5%, R$250) + trilha na auditoria',
      after.rows[0]?.commercial_model === 'hybrid' && Number(after.rows[0]?.commission_percent) === 12.5
        && Number(after.rows[0]?.monthly_fee) === 250 && audit.rows[0].n >= 1);
  } finally {
    // Faxina pós-0139: lançamento de comissão é IMUTÁVEL (DELETE barrado) e a FK
    // causal impede apagar a venda que tem lançamento. O caminho legítimo é CANCELAR
    // as vendas fake — o trigger estorna sozinho; fica resíduo inerte etiquetado TAG.
    // Blocos independentes: a ficha restaura SEMPRE, mesmo se o cancelamento falhar.
    if (partnerId && savedTerms) {
      try {
        await client.query(
          `UPDATE network.partners SET commercial_model=$3, commission_percent=$4, monthly_fee=$5 WHERE id=$1 AND environment=$2`,
          [partnerId, ENV, savedTerms.commercial_model, savedTerms.commission_percent, savedTerms.monthly_fee]);
        console.log('  (ficha do fantoche restaurada)');
      } catch (e) {
        console.log('  ⚠️ restauração da ficha falhou:', (e as Error).message);
      }
    }
    try {
      const ids = Object.values(orderIds);
      if (ids.length) {
        await client.query(
          `UPDATE commerce.partner_orders SET status='cancelled', updated_at=now()
            WHERE environment=$1 AND id = ANY($2) AND status<>'cancelled'`, [ENV, ids]);
      }
      console.log('  (faxina ok — vendas fake canceladas; lançamentos estornados pelo trigger, trilha preservada)');
    } catch (e) {
      console.log('  ⚠️ faxina falhou (cancelar na mão por TAG=' + TAG + '):', (e as Error).message);
    }
    client.release();
    await pool.end();
  }

  console.log(fails === 0 ? '\n✅ PROVA PASSOU (todos os checks)' : `\n❌ PROVA FALHOU (${fails} check(s))`);
  if (fails > 0) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
