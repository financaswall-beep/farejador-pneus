/**
 * PROVA de INTEGRAÇÃO das MODALIDADES DE DESPESA (0130) + FILTRO DE PERÍODO da
 * lista, no env `test`, chamando o CÓDIGO REAL (queries-despesas-categorias +
 * getMatrizExpenses com filtro + createMatrizExpense com guard + funções puras
 * da IA de comprovante). Blinda:
 *   seeds de fábrica ×2 envs + zero grant parceiro · criar/duplicar/normalizar
 *   acento · lançar SÓ em modalidade ATIVA (fantasma e arquivada → recusa) ·
 *   arquivar só custom ('outros' é fallback da IA — intocável) · recriar REATIVA
 *   (mesmo slug, não duplica) · filtro por mês na régua SP com borda de fuso ·
 *   filtro por modalidade com soma exata · RÉGUA CRUZADA: soma do período ==
 *   perna Despesas do consolidado (as duas telas NUNCA discordam) · truncamento
 *   honesto · prompt da IA ganha as modalidades do dono (puro, sem rede).
 *
 * Seeds descartáveis (created_by 'prova-desp-cat', slugs *_prova) e LIMPA tudo
 * (DELETE físico, despesas ANTES das categorias — FK RESTRICT) no finally.
 *
 * USO:
 *   npx tsx --env-file=.env.pooler scripts/prova-despesas-categorias-test.ts
 */

// Flags LIGADAS antes de qualquer import que leia `env` (parse no 1º import).
process.env.WHOLESALE_FINANCE = 'true';
process.env.MATRIZ_EXPENSES = 'true';
process.env.NETWORK_COMMISSION_LEDGER = 'true';

const ENV = 'test' as const;
const CREATED_BY = 'prova-desp-cat';
const SLUGS_PROVA = ['pedagio_prova', 'alimentacao_prova', 'cat_periodo_prova'];

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  const {
    listMatrizExpenseCategories, listActiveExpenseCategorySlugs,
    createMatrizExpenseCategory, archiveMatrizExpenseCategory, normalizeCategorySlug,
    getMatrizExpenses, createMatrizExpense, getMatrizFinanceiroVisao,
  } = await import('../src/admin/painel/queries.js');
  const { buildReceiptSystemPrompt, resolveReceiptCategory } = await import('../src/admin/painel/receipt-ai.js');

  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  console.log('=== PROVA MODALIDADES DE DESPESA (0130) + FILTRO DE PERÍODO (test) ===');

  const client = await pool.connect();
  let fails = 0;
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };
  const cents = (v: string | number): number => Math.round(Number(v) * 100);
  const limpar = async (): Promise<void> => {
    await client.query(`DELETE FROM commerce.matriz_expenses WHERE environment=$1 AND created_by LIKE $2`, [ENV, CREATED_BY + '%']);
    await client.query(`DELETE FROM commerce.matriz_expense_categories WHERE environment=$1 AND slug = ANY($2)`, [ENV, SLUGS_PROVA]);
  };

  try {
    await limpar(); // resto de rodada interrompida não pode sujar os números

    // ── 1. fundação da 0130: seeds ×2 envs + zero grant do parceiro ──
    const seeds = await client.query<{ environment: string; n: string }>(
      `SELECT environment::text, COUNT(*) AS n FROM commerce.matriz_expense_categories
        WHERE is_system GROUP BY environment`);
    const bySeed = Object.fromEntries(seeds.rows.map((r) => [r.environment, Number(r.n)]));
    check('1. seeds de fábrica: 6 em test e 6 em prod', bySeed['test'] === 6 && bySeed['prod'] === 6,
      `test=${bySeed['test']} prod=${bySeed['prod']}`);

    const grant = await client.query<{ sel: boolean; ins: boolean }>(
      `SELECT has_table_privilege('farejador_partner_app','commerce.matriz_expense_categories','SELECT') AS sel,
              has_table_privilege('farejador_partner_app','commerce.matriz_expense_categories','INSERT') AS ins`);
    check('2. parceiro ZERO acesso às modalidades', !grant.rows[0]!.sel && !grant.rows[0]!.ins);

    // ── 2. normalização do slug (pura) ──
    check('3. slug: "Pedágio Prova" → pedagio_prova', normalizeCategorySlug('Pedágio Prova') === 'pedagio_prova');
    check('4. slug: "Alimentação  da Equipe" achata acento/espaço', normalizeCategorySlug('Alimentação  da Equipe') === 'alimentacao_da_equipe');
    check('5. slug: curto demais vira vazio (recusável)', normalizeCategorySlug(' x ') === '');

    // ── 3. cadastrar modalidade ──
    const criada = await createMatrizExpenseCategory({ label: 'Pedágio Prova', created_by: CREATED_BY, environment: ENV });
    check('6. criar "Pedágio Prova" → slug pedagio_prova ativa', criada.id === 'pedagio_prova' && !criada.archived && !criada.is_system,
      JSON.stringify(criada));
    const ativas1 = await listActiveExpenseCategorySlugs(ENV);
    check('7. modalidade nova aparece nas ATIVAS (form do painel)', ativas1.some((c) => c.id === 'pedagio_prova'));

    let duplicou = '';
    try { await createMatrizExpenseCategory({ label: 'PEDAGIO prova', created_by: CREATED_BY, environment: ENV }); }
    catch (err) { duplicou = err instanceof Error ? err.message : String(err); }
    check('8. mesmo nome (até sem acento) já ativo → category_exists', duplicou === 'category_exists');

    // ── 4. lançar despesa SÓ em modalidade ativa ──
    const desp1 = await createMatrizExpense({ category: 'pedagio_prova', amount: 7.1, description: 'pedágio da prova', created_by: CREATED_BY, environment: ENV });
    check('9. despesa nasce na modalidade do dono', desp1.category === 'pedagio_prova' && cents(desp1.amount) === 710);

    let fantasma = '';
    try { await createMatrizExpense({ category: 'fantasma_prova', amount: 5, created_by: CREATED_BY, environment: ENV }); }
    catch (err) { fantasma = err instanceof Error ? err.message : String(err); }
    check('10. modalidade inexistente → category_invalid (nada gravado)', fantasma === 'category_invalid');

    // ── 5. arquivar (só custom) + recusa de lançamento + reativação ──
    await archiveMatrizExpenseCategory('pedagio_prova', ENV);
    const [todas, ativas2] = [await listMatrizExpenseCategories(ENV), await listActiveExpenseCategorySlugs(ENV)];
    check('11. arquivada some do form mas segue na lista (rótulo de despesa antiga)',
      !ativas2.some((c) => c.id === 'pedagio_prova') && todas.some((c) => c.id === 'pedagio_prova' && c.archived));

    let emArquivada = '';
    try { await createMatrizExpense({ category: 'pedagio_prova', amount: 3, created_by: CREATED_BY, environment: ENV }); }
    catch (err) { emArquivada = err instanceof Error ? err.message : String(err); }
    check('12. lançar em modalidade ARQUIVADA → category_invalid', emArquivada === 'category_invalid');

    const reativada = await createMatrizExpenseCategory({ label: 'Pedágio Prova', created_by: CREATED_BY, environment: ENV });
    const soUma = await client.query(`SELECT COUNT(*) AS n FROM commerce.matriz_expense_categories WHERE environment=$1 AND slug='pedagio_prova'`, [ENV]);
    check('13. recriar REATIVA o mesmo slug (não duplica linha)', !reativada.archived && Number(soUma.rows[0].n) === 1);

    let sistema = '';
    try { await archiveMatrizExpenseCategory('outros', ENV); }
    catch (err) { sistema = err instanceof Error ? err.message : String(err); }
    check("14. 'outros' (fábrica/fallback da IA) não arquiva", sistema === 'category_not_archivable');

    // ── 6. filtro de período (régua SP idêntica à do consolidado) ──
    await createMatrizExpenseCategory({ label: 'Cat Periodo Prova', created_by: CREATED_BY, environment: ENV });
    const dMes = await createMatrizExpense({ category: 'cat_periodo_prova', amount: 100, created_by: CREATED_BY + '-p', environment: ENV });
    const dMes2 = await createMatrizExpense({ category: 'cat_periodo_prova', amount: 23.45, created_by: CREATED_BY + '-p', environment: ENV });
    const dFora = await createMatrizExpense({ category: 'cat_periodo_prova', amount: 999, created_by: CREATED_BY + '-p', environment: ENV });
    // dFora vai pra 23:30 SP do ÚLTIMO dia do mês PASSADO (borda de fuso: em UTC já é o mês corrente!)
    await client.query(
      `UPDATE commerce.matriz_expenses
          SET occurred_at = (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') - interval '30 minutes'
        WHERE id = $1`, [dFora.id]);
    const mesSP = (await client.query<{ m: string }>(
      `SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') AS m`)).rows[0]!.m;
    const mesAnteriorSP = (await client.query<{ m: string }>(
      `SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo') - interval '1 month', 'YYYY-MM') AS m`)).rows[0]!.m;

    const noMes = await getMatrizExpenses(ENV, pool, { month: mesSP, category: 'cat_periodo_prova' });
    check('15. filtro mês×modalidade: só as 2 do mês entram', noMes.periodo?.count === 2 &&
      noMes.entries.every((e) => e.category === 'cat_periodo_prova') && !noMes.entries.some((e) => e.id === dFora.id),
      `count=${noMes.periodo?.count}`);
    check('16. soma do período EXATA (100 + 23,45)', cents(noMes.periodo?.total ?? 0) === 12345, noMes.periodo?.total);
    check('17. extrato do período em ordem cronológica (nova primeiro)',
      noMes.entries[0]?.id === dMes2.id && noMes.entries[1]?.id === dMes.id);

    const mesAnterior = await getMatrizExpenses(ENV, pool, { month: mesAnteriorSP, category: 'cat_periodo_prova' });
    check('18. borda de fuso: 23:30 SP do mês passado cai no mês PASSADO (não no corrente)',
      mesAnterior.periodo?.count === 1 && mesAnterior.entries[0]?.id === dFora.id && cents(mesAnterior.periodo?.total ?? 0) === 99900);

    // ── 7. RÉGUA CRUZADA: lista filtrada × consolidado (as telas nunca discordam) ──
    const [getMes, visao] = [await getMatrizExpenses(ENV, pool, { month: mesSP }), await getMatrizFinanceiroVisao(ENV, pool)];
    check('19. soma do mês (GET ?mes) == perna Despesas do consolidado',
      visao.mes.despesas !== null && cents(getMes.periodo?.total ?? 0) === cents(visao.mes.despesas),
      `lista=${getMes.periodo?.total} visao=${visao.mes.despesas}`);

    // ── 8. compat/robustez ──
    const semFiltro = await getMatrizExpenses(ENV, pool);
    check('20. sem filtro: periodo null (visão intocada) e agenda como era', semFiltro.periodo === null && Array.isArray(semFiltro.entries));
    check('21. a_pagar é GLOBAL (dívida não some quando filtro o mês)',
      semFiltro.a_pagar_total === noMes.a_pagar_total && semFiltro.pago_mes_total === getMes.pago_mes_total);
    const trunc = await getMatrizExpenses(ENV, pool, { category: 'cat_periodo_prova', limit: 1 });
    check('22. truncamento honesto: limit 1 → truncado=true, count diz o total', trunc.entries.length === 1 &&
      trunc.periodo?.truncado === true && trunc.periodo?.count === 3);

    // ── 9. IA de comprovante enxerga as modalidades do dono (puro, sem rede) ──
    const prompt = buildReceiptSystemPrompt([
      { id: 'combustivel', label: 'Combustível' }, { id: 'manutencao', label: 'Manutenção' },
      { id: 'frete', label: 'Frete pago' }, { id: 'outros', label: 'Outros' },
      { id: 'pedagio_prova', label: 'Pedágio Prova' },
    ]);
    check('23. prompt da IA lista a modalidade do dono no vocabulário',
      prompt.includes('pedagio_prova') && prompt.includes('Modalidades do dono') && prompt.includes('"pedagio_prova" = Pedágio Prova'));
    const promptSo6 = buildReceiptSystemPrompt(['aluguel', 'funcionario', 'combustivel', 'frete', 'manutencao', 'outros'].map((id) => ({ id, label: id })));
    check('24. sem modalidade extra, prompt fica no vocabulário de fábrica', !promptSo6.includes('Modalidades do dono'));
    check('25. leitura da IA: slug do dono vale; invenção cai em outros',
      resolveReceiptCategory('pedagio_prova', ['combustivel', 'outros', 'pedagio_prova']) === 'pedagio_prova' &&
      resolveReceiptCategory('categoria_inventada', ['combustivel', 'outros']) === 'outros');

    console.log(fails === 0 ? '\n✅ PROVA VERDE (25/25)' : `\n❌ ${fails} CHECK(S) VERMELHO(S)`);
    process.exitCode = fails === 0 ? 0 : 1;
  } finally {
    await limpar();
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('PROVA ESTOUROU:', err);
  process.exitCode = 1;
});
