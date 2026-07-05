/**
 * PROVA de INTEGRAÇÃO dos COLABORADORES DA MATRIZ (0124, 2026-07-04). Roda no
 * env `test` chamando o CÓDIGO REAL. Blinda:
 *   criar (pessoa da porta única + vínculo, atômico) · username duplicado recusa ·
 *   senha vira hash scrypt (banco nunca vê texto) · **colaborador NÃO loga em
 *   lugar nenhum** (authenticatePersonGlobal devolve null — fatia 1 sem telas) ·
 *   mudar função · trocar senha (velha morre, nova vale) · revogar tira da ativa
 *   E libera o username (recadastrar com o mesmo usuário funciona) · reativar com
 *   username ocupado recusa; liberado, volta com a MESMA senha · isolamento de
 *   environment (prod não enxerga seed do test) · ZERO GRANT pro
 *   farejador_partner_app na tabela nova.
 *
 * Seeds descartáveis (username prova.colab.*) e LIMPA no início e no finally.
 *
 * USO:
 *   npx tsx --env-file=.env.pooler scripts/prova-matriz-colaboradores-test.ts
 */

const ENV = 'test' as const;
const U1 = 'prova.colab.a';
const U2 = 'prova.colab.b';
const SENHA1 = 'senha-prova-123';
const SENHA2 = 'outra-senha-456';

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  const {
    listMatrizCollaborators, createMatrizCollaborator, updateMatrizCollaboratorJob,
    revokeMatrizCollaborator, reactivateMatrizCollaborator, resetMatrizCollaboratorPassword,
    MatrizCollaboratorUsernameTakenError,
  } = await import('../src/admin/painel/queries.js');
  const { authenticatePersonGlobal } = await import('../src/parceiro/people.js');
  const { verifyPassword } = await import('../src/parceiro/password.js');

  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  console.log('=== PROVA COLABORADORES DA MATRIZ (test) ===');

  let fails = 0;
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };

  const limpar = async (): Promise<void> => {
    await pool.query(
      `DELETE FROM network.matriz_collaborators
        WHERE environment = $1 AND person_id IN (
          SELECT id FROM network.partner_people
           WHERE environment = $1 AND lower(username) LIKE 'prova.colab.%')`,
      [ENV],
    );
    await pool.query(
      `DELETE FROM network.partner_people
        WHERE environment = $1 AND lower(username) LIKE 'prova.colab.%'`,
      [ENV],
    );
  };

  await limpar(); // restos de rodada anterior não contaminam

  try {
    // ── L1: criar vendedor (pessoa + vínculo, atômico) ─────────────────────
    const c1 = await createMatrizCollaborator({
      display_name: 'PROVA-COLAB João', username: U1, password: SENHA1, job: 'vendedor', actor_label: 'prova',
    });
    check('L1a criar devolve id', !!c1.id);
    let lista = await listMatrizCollaborators(ENV);
    let l1 = lista.find((c) => c.username === U1);
    check('L1b aparece na lista ativo', !!l1 && l1.active === true);
    check('L1c função = vendedor', l1?.job === 'vendedor');

    // ── L2: username duplicado recusa (índice único da porta única) ────────
    let dupErr: unknown = null;
    try {
      await createMatrizCollaborator({ display_name: 'PROVA-COLAB Clone', username: U1.toUpperCase(), password: SENHA1, job: 'entregador' });
    } catch (err) { dupErr = err; }
    check('L2 username duplicado (case-insensitive) recusa', dupErr instanceof MatrizCollaboratorUsernameTakenError);

    // ── L3: banco guarda hash scrypt, nunca a senha em texto ───────────────
    const pp = await pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM network.partner_people WHERE environment=$1 AND lower(username)=lower($2) AND revoked_at IS NULL`,
      [ENV, U1],
    );
    check('L3 senha no banco é scrypt:<salt>:<hash>', /^scrypt:[0-9a-f]+:[0-9a-f]+$/.test(pp.rows[0]?.password_hash ?? ''));

    // ── L4: SEGURANÇA — colaborador NÃO loga em lugar nenhum (fatia 1) ─────
    const auth = await authenticatePersonGlobal(ENV, U1, SENHA1);
    check('L4 login com a senha CERTA devolve null (sem loja = sem porta)', auth === null);

    // ── L5: mudar função ────────────────────────────────────────────────────
    const jobRes = await updateMatrizCollaboratorJob({ environment: ENV, id: c1.id, job: 'entregador' });
    lista = await listMatrizCollaborators(ENV);
    l1 = lista.find((c) => c.username === U1);
    check('L5 virou entregador', jobRes.updated && l1?.job === 'entregador');

    // ── L6: trocar senha (velha morre, nova vale) ──────────────────────────
    const resetRes = await resetMatrizCollaboratorPassword({ environment: ENV, id: c1.id, password: SENHA2 });
    const pp2 = await pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM network.partner_people WHERE environment=$1 AND lower(username)=lower($2) AND revoked_at IS NULL`,
      [ENV, U1],
    );
    check('L6a reset devolve reset=true', resetRes.reset === true);
    check('L6b senha nova confere', await verifyPassword(SENHA2, pp2.rows[0]?.password_hash ?? null));
    check('L6c senha velha morreu', !(await verifyPassword(SENHA1, pp2.rows[0]?.password_hash ?? null)));

    // ── L7: revogar tira da ativa e revoga a pessoa (username liberado) ────
    const revRes = await revokeMatrizCollaborator({ environment: ENV, id: c1.id });
    lista = await listMatrizCollaborators(ENV);
    l1 = lista.find((c) => c.id === c1.id);
    const ppRev = await pool.query<{ revoked_at: string | null }>(
      `SELECT revoked_at FROM network.partner_people WHERE environment=$1 AND lower(username)=lower($2) ORDER BY created_at DESC LIMIT 1`,
      [ENV, U1],
    );
    check('L7a revogado sai da ativa (trilha fica)', revRes.revoked && !!l1 && l1.active === false);
    check('L7b pessoa revogada junto (username livre)', ppRev.rows[0]?.revoked_at !== null);
    check('L7c trocar senha de revogado NÃO pega', (await resetMatrizCollaboratorPassword({ environment: ENV, id: c1.id, password: 'nao-vale-000' })).reset === false);

    // ── L8: mesmo username de novo (prova que revogar liberou) ─────────────
    const c2 = await createMatrizCollaborator({
      display_name: 'PROVA-COLAB Maria', username: U1, password: SENHA1, job: 'vendedor',
    });
    check('L8 recadastrar com o username liberado funciona', !!c2.id);

    // ── L9: reativar com username OCUPADO recusa ───────────────────────────
    let reatErr: unknown = null;
    try { await reactivateMatrizCollaborator({ environment: ENV, id: c1.id }); } catch (err) { reatErr = err; }
    check('L9 reativar com username ocupado recusa (username_taken)', reatErr instanceof MatrizCollaboratorUsernameTakenError);

    // ── L10: liberou (revogou o 2º) → reativar volta com a MESMA senha ─────
    await revokeMatrizCollaborator({ environment: ENV, id: c2.id });
    const reatRes = await reactivateMatrizCollaborator({ environment: ENV, id: c1.id });
    lista = await listMatrizCollaborators(ENV);
    l1 = lista.find((c) => c.id === c1.id);
    const ppReat = await pool.query<{ password_hash: string }>(
      `SELECT pp.password_hash FROM network.partner_people pp
        JOIN network.matriz_collaborators mc ON mc.person_id = pp.id
       WHERE mc.id = $2 AND mc.environment = $1`,
      [ENV, c1.id],
    );
    check('L10a reativar funciona com username livre', reatRes.reactivated && !!l1 && l1.active === true);
    check('L10b volta com a MESMA senha de antes (a trocada no L6)', await verifyPassword(SENHA2, ppReat.rows[0]?.password_hash ?? null));

    // ── L11: isolamento de environment (prod não enxerga seed do test) ─────
    const listaProd = await listMatrizCollaborators('prod');
    check('L11 prod não enxerga colaborador do test', !listaProd.some((c) => c.username.toLowerCase().startsWith('prova.colab.')));

    // ── L12: ZERO GRANT pro pool do parceiro (regra de ouro da matriz) ─────
    const grants = await pool.query<{ sel: boolean; ins: boolean }>(
      `SELECT has_table_privilege('farejador_partner_app', 'network.matriz_collaborators', 'SELECT') AS sel,
              has_table_privilege('farejador_partner_app', 'network.matriz_collaborators', 'INSERT') AS ins`,
    );
    check('L12 farejador_partner_app NÃO lê nem escreve na tabela nova',
      grants.rows[0]?.sel === false && grants.rows[0]?.ins === false);
  } finally {
    await limpar();
    await pool.end();
  }

  console.log(fails === 0 ? '\n✅ PROVA COLABORADORES: tudo verde.' : `\n❌ PROVA COLABORADORES: ${fails} falha(s).`);
  if (fails > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('PROVA quebrou:', err);
  process.exitCode = 1;
});
