/**
 * PROVA de INTEGRAÇÃO da VISÃO CONSOLIDADA do FINANCEIRO DA MATRIZ (Onda 1, SÓ
 * leitura) no env `test`, chamando o CÓDIGO REAL (getMatrizFinanceiroVisao +
 * escritas das fontes: createMatrizExpense / registerWholesaleSale / seed de
 * comissão). Blinda o agregador:
 *   consolidado do mês soma as 3 pernas e desconta despesa (competência) ·
 *   A RECEBER junta fiado (com telefone) + comissão por parceiro · A PAGAR junta
 *   fornecedor + despesa pendente em agenda (vencido primeiro) · indicadores
 *   (capital parado, giro, fiado %, ponto de equilíbrio) com guarda null ·
 *   quitar fonte reflete na visão · a visão NÃO roda o sweep (leitura pura).
 *
 * Seeds descartáveis (medida '97/97-97', created_by 'prova-fin-visao') e LIMPA
 * tudo (DELETE físico) no finally.
 *
 * USO:
 *   npx tsx --env-file=.env.pooler scripts/prova-financeiro-visao-test.ts
 */

// Flags LIGADAS antes de qualquer import que leia `env` (parse no 1º import).
process.env.WHOLESALE_FINANCE = 'true';
process.env.MATRIZ_EXPENSES = 'true';
process.env.NETWORK_COMMISSION_LEDGER = 'true';

const ENV = 'test' as const;
const MEASURE = '97/97-97'; // descartável ('98' é do fiado, '99' das outras provas)
const CREATED_BY = 'prova-fin-visao';

function isoDate(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  const {
    getMatrizFinanceiroVisao, createMatrizExpense, removeMatrizExpense,
    registerWholesaleSale, settleWholesaleOrderPayment,
  } = await import('../src/admin/painel/queries.js');

  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  console.log('=== PROVA VISÃO DO FINANCEIRO DA MATRIZ (test) ===');

  const client = await pool.connect();
  let fails = 0;
  let buyerId = '';
  let comissaoId = '';
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };
  const cents = (n: number): number => Math.round(n * 100);

  try {
    // ── setup: catálogo + galpão (50un × R$10) + borracheiro COM telefone ──
    const prod = await client.query<{ id: string }>(`SELECT id FROM commerce.products WHERE environment=$1 LIMIT 1`, [ENV]);
    if (!prod.rows[0]) throw new Error('sem produto no env test pra ancorar o tire_specs');
    await client.query(`DELETE FROM commerce.tire_specs WHERE environment=$1 AND tire_size=$2`, [ENV, MEASURE]);
    await client.query(
      `INSERT INTO commerce.tire_specs (environment, product_id, tire_size, width_mm, aspect_ratio, rim_diameter)
       VALUES ($1,$2,$3,97,97,97)`, [ENV, prod.rows[0].id, MEASURE]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(
      `INSERT INTO commerce.wholesale_stock (environment, measure, quantity_on_hand, unit_cost) VALUES ($1,$2,50,10)`, [ENV, MEASURE]);
    const b = await client.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_customers (environment, name, phone) VALUES ($1,'PROVA-VISAO-BORRACHEIRO','21988887777') RETURNING id`, [ENV]);
    buyerId = b.rows[0]!.id;
    check('setup: catálogo + galpão 50un×R$10 + borracheiro com telefone', true);

    // ── régua de partida (test pode ter lixo de outras frentes) ──
    const base = await getMatrizFinanceiroVisao(ENV, pool);
    const baseReceber = Number(base.a_receber.total);
    const basePagar = Number(base.a_pagar.total);
    const baseDespesas = Number(base.mes.despesas ?? 0);
    const baseLucro = Number(base.mes.lucro);
    const baseFat = Number(base.mes.faturamento);
    const baseVencReceber = base.a_receber.vencidos_count;
    const baseCapital = Number(base.indicadores.capital_parado);

    // ── V1: estrutura + fontes ligadas ──
    check('V1 fontes refletem as flags (fiado/comissão/despesas = true)',
      base.fontes.fiado && base.fontes.comissao && base.fontes.despesas);
    check('V1b capital parado inclui o galpão do setup (+R$500 = 50×10)',
      cents(baseCapital) >= 50000, `capital=${base.indicadores.capital_parado}`);

    // ── V2: despesa À VISTA 120 → competência do mês (despesas +120, lucro −120) ──
    const d1 = await createMatrizExpense(
      { category: 'combustivel', description: 'PROVA gasolina', amount: 120,
        created_by: CREATED_BY, environment: ENV }, pool);
    let v = await getMatrizFinanceiroVisao(ENV, pool);
    check('V2 despesa à vista soma na competência do mês (+120)',
      cents(Number(v.mes.despesas ?? 0) - baseDespesas) === 12000, `${baseDespesas} → ${v.mes.despesas}`);
    check('V2b lucro do mês desce os mesmos 120',
      cents(Number(v.mes.lucro) - baseLucro) === -12000, `${baseLucro} → ${v.mes.lucro}`);
    check('V2c categoria aparece no rodapé (combustivel)',
      (v.mes.despesas_categoria || []).some((c) => c.category === 'combustivel'));
    check('V2d à vista NÃO entra no a pagar',
      cents(Number(v.a_pagar.total) - basePagar) === 0, `${basePagar} → ${v.a_pagar.total}`);

    // ── V3: despesa A PAGAR 800 (vence em 5d) → agenda ──
    const d2 = await createMatrizExpense(
      { category: 'aluguel', description: 'PROVA aluguel', amount: 800,
        payment_status: 'pending', due_date: isoDate(5), created_by: CREATED_BY, environment: ENV }, pool);
    v = await getMatrizFinanceiroVisao(ENV, pool);
    const ag1 = v.a_pagar.itens.find((x) => x.tipo === 'despesa' && x.id === d2.id);
    check('V3 despesa pendente entra no A PAGAR (+800)',
      cents(Number(v.a_pagar.total) - basePagar) === 80000, `${basePagar} → ${v.a_pagar.total}`);
    check('V3b agenda tem a despesa com vencimento e categoria',
      !!ag1 && ag1.due_date != null && ag1.categoria === 'aluguel' && ag1.overdue === false,
      ag1 ? `due=${ag1.due_date}` : 'NÃO ACHOU');

    // ── V4: venda FIADA já VENCIDA (2×R$50, venceu ontem) → A RECEBER com telefone ──
    const venda = await registerWholesaleSale(
      { customer_id: buyerId, items: [{ measure: MEASURE, quantity: 2, unit_price: 50 }],
        created_by: CREATED_BY, environment: ENV, payment_status: 'pending', due_date: isoDate(-1) }, pool);
    v = await getMatrizFinanceiroVisao(ENV, pool);
    const rec1 = v.a_receber.itens.find((x) => x.tipo === 'fiado' && x.id === venda.order_id);
    check('V4 fiado entra no A RECEBER (+100)',
      cents(Number(v.a_receber.total) - baseReceber) === 10000, `${baseReceber} → ${v.a_receber.total}`);
    check('V4b item tem TELEFONE (pro Cobrar no WhatsApp) e tá vencido',
      !!rec1 && rec1.phone === '21988887777' && rec1.overdue === true,
      rec1 ? `phone=${rec1.phone} overdue=${rec1.overdue}` : 'NÃO ACHOU');
    check('V4c vencidos do a receber contam +1',
      v.a_receber.vencidos_count - baseVencReceber === 1, String(v.a_receber.vencidos_count));
    check('V4d vencido vem PRIMEIRO na lista', v.a_receber.itens[0]?.overdue === true);
    check('V4e faturamento do mês subiu +100 (perna do atacado)',
      cents(Number(v.mes.faturamento) - baseFat) === 10000, `${baseFat} → ${v.mes.faturamento}`);
    check('V4f fiado do mês em aberto > 0%',
      v.indicadores.fiado_aberto_pct !== null && v.indicadores.fiado_aberto_pct > 0,
      String(v.indicadores.fiado_aberto_pct));

    // ── V5: lançamento de COMISSÃO em aberto (seed direto; a visão SÓ LÊ o livro) ──
    const pu = await client.query<{ partner_id: string; unit_id: string }>(
      `SELECT pu.partner_id, pu.unit_id FROM network.partner_units pu
        JOIN network.partners p ON p.id = pu.partner_id AND p.environment = pu.environment
       WHERE pu.environment = $1 AND pu.deleted_at IS NULL AND p.deleted_at IS NULL LIMIT 1`, [ENV]);
    if (!pu.rows[0]) throw new Error('sem parceiro no env test pro seed de comissão');
    const ce = await client.query<{ id: string }>(
      `INSERT INTO network.commission_entries
         (environment, partner_id, partner_unit_id, unit_id, partner_order_id,
          order_total, commission_percent, commission_amount, status, realized_at)
       VALUES ($1, $2, NULL, $3, gen_random_uuid(), 1000, 10, 100, 'open', now())
       RETURNING id`, [ENV, pu.rows[0].partner_id, pu.rows[0].unit_id]);
    comissaoId = ce.rows[0]!.id;
    v = await getMatrizFinanceiroVisao(ENV, pool);
    const recCom = v.a_receber.itens.find((x) => x.tipo === 'comissao' && x.id === pu.rows[0]!.partner_id);
    check('V5 comissão em aberto soma no A RECEBER (+100 = fiado 100 + comissão 100)',
      cents(Number(v.a_receber.total) - baseReceber) === 20000, `${baseReceber} → ${v.a_receber.total}`);
    check('V5b item de comissão por parceiro com contagem de vendas',
      !!recCom && (recCom.count ?? 0) >= 1 && Number(recCom.valor) >= 100,
      recCom ? `${recCom.nome} R$${recCom.valor} (${recCom.count})` : 'NÃO ACHOU');
    check('V5c comissão realizada no mês entra na perna (≥100)',
      v.mes.pernas.comissao !== null && Number(v.mes.pernas.comissao.realizado) >= 100,
      String(v.mes.pernas.comissao?.realizado));

    // ── V6: indicadores com base → números redondos e sem NaN ──
    check('V6 giro do estoque calculado (custo do mês > 0 → dias inteiros)',
      v.indicadores.giro_dias !== null && Number.isInteger(v.indicadores.giro_dias),
      String(v.indicadores.giro_dias));
    check('V6b ponto de equilíbrio calculado (despesa e margem > 0)',
      v.indicadores.ponto_equilibrio !== null && v.indicadores.ponto_equilibrio > 0,
      String(v.indicadores.ponto_equilibrio));
    check('V6c margem do mês é número (não NaN)',
      v.mes.margem_pct === null || Number.isFinite(v.mes.margem_pct), String(v.mes.margem_pct));

    // ── V7: QUITAR o fiado → some do A RECEBER da visão (fica só a comissão) ──
    await settleWholesaleOrderPayment(venda.order_id, ENV, pool);
    v = await getMatrizFinanceiroVisao(ENV, pool);
    check('V7 fiado quitado sai da visão (sobra só a comissão = +100)',
      cents(Number(v.a_receber.total) - baseReceber) === 10000, `${v.a_receber.total}`);
    check('V7b vencidos do a receber voltam ao base',
      v.a_receber.vencidos_count === baseVencReceber, String(v.a_receber.vencidos_count));

    // ── V8: REMOVER a despesa pendente → a pagar volta ao base ──
    await removeMatrizExpense(d2.id, ENV, pool);
    await removeMatrizExpense(d1.id, ENV, pool);
    v = await getMatrizFinanceiroVisao(ENV, pool);
    check('V8 despesas removidas → a pagar volta ao base',
      cents(Number(v.a_pagar.total) - basePagar) === 0, `${v.a_pagar.total}`);
    check('V8b competência do mês volta ao base (soft delete some das contas)',
      cents(Number(v.mes.despesas ?? 0) - baseDespesas) === 0, `${v.mes.despesas}`);

    console.log(`\n${fails === 0 ? '✅ VISÃO DO FINANCEIRO PROVADA (3 pernas + a receber/a pagar juntos + telefone + indicadores + quitações refletem)' : `❌ ${fails} CASO(S) FALHARAM`}`);
  } finally {
    if (comissaoId) await client.query(`DELETE FROM network.commission_entries WHERE id=$1`, [comissaoId]);
    await client.query(
      `DELETE FROM commerce.wholesale_order_items WHERE environment=$1 AND order_id IN
         (SELECT id FROM commerce.wholesale_orders WHERE environment=$1 AND created_by=$2)`, [ENV, CREATED_BY]);
    await client.query(`DELETE FROM commerce.wholesale_orders WHERE environment=$1 AND created_by=$2`, [ENV, CREATED_BY]);
    await client.query(`DELETE FROM commerce.matriz_expenses WHERE environment=$1 AND created_by=$2`, [ENV, CREATED_BY]);
    if (buyerId) await client.query(`DELETE FROM commerce.wholesale_customers WHERE id=$1`, [buyerId]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(`DELETE FROM commerce.tire_specs WHERE environment=$1 AND tire_size=$2`, [ENV, MEASURE]);
    client.release();
    await pool.end();
  }
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
