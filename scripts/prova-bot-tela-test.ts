/**
 * PROVA de INTEGRAÇÃO — TELA DO BOT (campainha + visão) no env `test`,
 * chamando o CÓDIGO REAL (getBotCampainha / getBotVisao).
 * Blinda:
 *   campainha acusa cliente ESPERANDO (≥5 min, sem resposta entregue) · grace de
 *   5 min não alarma conversa em andamento · resposta ENTREGUE cala a campainha ·
 *   mensagem NOVA depois da resposta REACENDE (régua do stale-trigger invertida) ·
 *   escalou pra humano aparece com motivo · mapa soma por município (delta) ·
 *   pedido_criado vira "pediu" · faltou_estoque vira "faltou" no mapa e linha no
 *   radar com motivo + estoque do galpão · conversa sem município cai em
 *   sem_regiao · fact FORA da janela 30d não conta.
 * Fatia 2 (funil/boca/mais-pedidas): stage_reached vira funil (delta) ·
 *   loss_reason vira perda por motivo (delta) · hint de linguagem vira "boca do
 *   cliente" por conversa distinta (delta) · medida_consultada vira "mais pedidas"
 *   cruzada com o galpão · cards ganharam faturamento/ticket_medio/resposta_seg.
 *
 * Seeds descartáveis (chatwoot_account_id=93939, contato 'PROVA-BOT contato',
 * medida '93/93-93', source 'prova_bot') com pré-limpeza + limpeza no finally.
 * Checks de contagem do mapa são por DELTA (antes × depois) — imunes a dado
 * pré-existente no env test.
 *
 * USO:
 *   npx tsx --env-file=.env.pooler scripts/prova-bot-tela-test.ts
 */
const ENV = 'test' as const;
const ACC = 93939; // marcador das conversas de prova
const MEASURE = '93/93-93'; // descartável (94 sino, 95 logistica, 97 visao, 98 fiado)

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  const { getBotCampainha, getBotVisao } = await import('../src/admin/painel/queries.js');

  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  console.log('=== PROVA TELA DO BOT (test) ===');

  const client = await pool.connect();
  let fails = 0;
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };

  const limpar = async (): Promise<void> => {
    await client.query(
      `DELETE FROM analytics.conversation_classifications WHERE conversation_id IN (
         SELECT id FROM core.conversations WHERE environment=$1 AND chatwoot_account_id=$2)`,
      [ENV, ACC]);
    await client.query(
      `DELETE FROM analytics.linguistic_hints WHERE conversation_id IN (
         SELECT id FROM core.conversations WHERE environment=$1 AND chatwoot_account_id=$2)`,
      [ENV, ACC]);
    await client.query(
      `DELETE FROM analytics.conversation_facts WHERE conversation_id IN (
         SELECT id FROM core.conversations WHERE environment=$1 AND chatwoot_account_id=$2)`,
      [ENV, ACC]);
    await client.query(
      `DELETE FROM agent.turns WHERE environment=$1 AND conversation_id IN (
         SELECT id FROM core.conversations WHERE environment=$1 AND chatwoot_account_id=$2)`,
      [ENV, ACC]);
    await client.query(
      `DELETE FROM core.messages WHERE environment=$1 AND conversation_id IN (
         SELECT id FROM core.conversations WHERE environment=$1 AND chatwoot_account_id=$2)`,
      [ENV, ACC]);
    await client.query(
      `DELETE FROM core.conversations WHERE environment=$1 AND chatwoot_account_id=$2`, [ENV, ACC]);
    await client.query(
      `DELETE FROM core.contacts WHERE environment=$1 AND name='PROVA-BOT contato'`, [ENV]);
    await client.query(
      `DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
  };

  const novaConversa = async (contactId: string, n: number): Promise<string> => {
    const r = await client.query<{ id: string }>(
      `INSERT INTO core.conversations
         (environment, chatwoot_conversation_id, chatwoot_account_id, contact_id, current_status, started_at)
       VALUES ($1::env_t, $2, $3, $4, 'open', now() - interval '2 hours') RETURNING id`,
      [ENV, 9393900 + n, ACC, contactId]);
    return r.rows[0]!.id;
  };

  const novaMsg = async (convId: string, n: number, minutosAtras: number, texto: string): Promise<string> => {
    const r = await client.query<{ id: string }>(
      `INSERT INTO core.messages
         (environment, chatwoot_message_id, conversation_id, chatwoot_conversation_id,
          sender_type, message_type, content, is_private, sent_at)
       VALUES ($1::env_t, $2, $3, $4, 'contact', 0, $5, false, now() - ($6 || ' minutes')::interval)
       RETURNING id`,
      [ENV, 93939000 + n, convId, 9393900, texto, String(minutosAtras)]);
    return r.rows[0]!.id;
  };

  const novoFact = async (convId: string, key: string, value: unknown, diasAtras = 0): Promise<void> => {
    await client.query(
      `INSERT INTO analytics.conversation_facts
         (environment, conversation_id, fact_key, fact_value, truth_type, source, extractor_version, created_at)
       VALUES ($1::env_t, $2, $3, $4::jsonb, 'observed', 'prova_bot', 'prova_v1',
               now() - ($5 || ' days')::interval)`,
      [ENV, convId, key, JSON.stringify(value), String(diasAtras)]);
  };

  try {
    await limpar(); // run interrompido não envenena este

    // ── visão ANTES dos seeds (baseline pro delta) ──
    const antes = await getBotVisao('30d', ENV, pool);
    const antesMarica = antes.mapa.find((m) => m.municipio === 'Maricá');
    const funilDe = (p: Awaited<ReturnType<typeof getBotVisao>>, etapa: string): number =>
      p.funil.find((x) => x.etapa === etapa)?.n ?? 0;
    const perdaDe = (p: Awaited<ReturnType<typeof getBotVisao>>, motivo: string): number =>
      p.perdas.find((x) => x.motivo === motivo)?.n ?? 0;
    const bocaDe = (p: Awaited<ReturnType<typeof getBotVisao>>, tipo: string): number =>
      p.boca.find((x) => x.tipo === tipo)?.convs ?? 0;
    const a = { chamou: antesMarica?.chamou ?? 0, pediu: antesMarica?.pediu ?? 0,
      faltou: antesMarica?.faltou ?? 0, semRegiao: antes.sem_regiao,
      funilPedido: funilDe(antes, 'pedido_criado'), funilFrete: funilDe(antes, 'frete_calculado'),
      perdaPreco: perdaDe(antes, 'objecao_preco'), bocaParcelado: bocaDe(antes, 'pergunta_parcelamento'),
      respondidas48h: Number(antes.cards?.respondidas_bot_48h ?? 0) };

    // ── setup: contato + 4 conversas ──
    const ct = await client.query<{ id: string }>(
      `INSERT INTO core.contacts (environment, chatwoot_contact_id, name)
       VALUES ($1::env_t, $2, 'PROVA-BOT contato') RETURNING id`, [ENV, 93939001]);
    const contactId = ct.rows[0]!.id;
    const conv1 = await novaConversa(contactId, 1);
    const conv2 = await novaConversa(contactId, 2);
    const conv3 = await novaConversa(contactId, 3);
    const conv4 = await novaConversa(contactId, 4);

    // ── B1: cliente esperando há 10 min, bot nunca respondeu → campainha acusa ──
    const msg1 = await novaMsg(conv1, 1, 10, 'tem pneu 93/93-93?');
    let camp = await getBotCampainha(ENV, pool);
    let muda1 = camp.mudas.find((m) => m.conversation_id === conv1);
    check('B1 cliente esperando 10 min acende a campainha', !!muda1,
      muda1 ? `minutos=${muda1.minutos}, preview="${muda1.preview}"` : 'não apareceu');

    // ── B2: mensagem de 2 min NÃO alarma (grace de 5 min) ──
    const msg2 = await novaMsg(conv2, 2, 2, 'oi');
    camp = await getBotCampainha(ENV, pool);
    check('B2 conversa em andamento (2 min) NÃO alarma', !camp.mudas.some((m) => m.conversation_id === conv2));

    // ── B3: resposta ENTREGUE cala a campainha ──
    await client.query(
      `INSERT INTO agent.turns (environment, conversation_id, trigger_message_id, agent_version, context_hash, status)
       VALUES ($1::env_t, $2, $3, 'v2', 'prova', 'delivered')`, [ENV, conv1, msg1]);
    camp = await getBotCampainha(ENV, pool);
    check('B3 resposta entregue cala a campainha', !camp.mudas.some((m) => m.conversation_id === conv1));

    // ── B4: mensagem NOVA depois da resposta reacende ──
    await novaMsg(conv1, 3, 6, 'e o preço?');
    camp = await getBotCampainha(ENV, pool);
    muda1 = camp.mudas.find((m) => m.conversation_id === conv1);
    check('B4 mensagem nova depois da resposta REACENDE', !!muda1 && muda1.preview.includes('preço'));

    // ── B5: escalou pra humano aparece com motivo ──
    await novoFact(conv2, 'escalou', true);
    await novoFact(conv2, 'motivo_escalacao', 'cliente pediu atendente');
    camp = await getBotCampainha(ENV, pool);
    const esc = camp.escalados.find((e) => e.conversation_id === conv2);
    check('B5 escalou aparece na campainha com motivo', !!esc && String(esc.motivo).includes('atendente'),
      esc ? `motivo="${esc.motivo}"` : 'não apareceu');

    // ── seeds da visão: Maricá chamou 2× (conv1 pediu; conv2 faltou) ──
    await novoFact(conv1, 'municipio_entrega', 'Maricá');
    await novoFact(conv1, 'pedido_criado', true);
    await novoFact(conv2, 'municipio_entrega', 'Maricá');
    await novoFact(conv2, 'faltou_estoque', { motivo: 'sem_estoque_perto', medida: MEASURE });
    await novoFact(conv3, 'medida_consultada', MEASURE); // sem município → sem_regiao
    await novoFact(conv4, 'municipio_entrega', 'Maricá', 35); // FORA da janela 30d
    await client.query(
      `INSERT INTO commerce.wholesale_stock (environment, measure, quantity_on_hand)
       VALUES ($1::env_t, $2, 4)`, [ENV, MEASURE]);

    // ── seeds fatia 2: funil/perdas (classifications, espelho do _insert_classification)
    //    + boca (linguistic_hint na msg da conv2) ──
    const novaClass = async (convId: string, dimension: string, value: string): Promise<void> => {
      await client.query(
        `INSERT INTO analytics.conversation_classifications
           (environment, conversation_id, dimension, value, truth_type, source,
            confidence_level, extractor_version, ruleset_hash)
         VALUES ($1::env_t, $2, $3, $4, 'inferred', 'prova_bot', 1.00, 'prova_v1', 'prova_v1')`,
        [ENV, convId, dimension, value]);
    };
    await novaClass(conv1, 'stage_reached', 'pedido_criado');
    await novaClass(conv2, 'stage_reached', 'frete_calculado');
    await novaClass(conv2, 'loss_reason', 'objecao_preco');
    await client.query(
      `INSERT INTO analytics.linguistic_hints
         (environment, conversation_id, message_id, hint_type, matched_text, pattern_id,
          truth_type, source, confidence_level, extractor_version, ruleset_hash)
       VALUES ($1::env_t, $2, $3, 'pergunta_parcelamento', 'fiado', 'prova',
               'observed', 'prova_bot', 0.90, 'prova_v1', 'prova_v1')`,
      [ENV, conv2, msg2]);

    const depois = await getBotVisao('30d', ENV, pool);
    const marica = depois.mapa.find((m) => m.municipio === 'Maricá');
    const d = { chamou: marica?.chamou ?? 0, pediu: marica?.pediu ?? 0, faltou: marica?.faltou ?? 0 };

    check('B6 mapa: Maricá chamou +2 (janela 30d)', d.chamou === a.chamou + 2,
      `antes=${a.chamou} depois=${d.chamou}`);
    check('B7 mapa: pedido_criado vira "pediu" (+1)', d.pediu === a.pediu + 1,
      `antes=${a.pediu} depois=${d.pediu}`);
    check('B8 mapa: faltou_estoque vira "faltou" (+1)', d.faltou === a.faltou + 1,
      `antes=${a.faltou} depois=${d.faltou}`);
    check('B9 fact de 35 dias NÃO conta na janela 30d', d.chamou === a.chamou + 2,
      'senão seria +3');
    check('B10 conversa sem município cai em sem_regiao (+1 ou mais)',
      depois.sem_regiao >= a.semRegiao + 1, `antes=${a.semRegiao} depois=${depois.sem_regiao}`);

    const rad = depois.radar.find((r) => r.medida === MEASURE);
    check('B11 radar: medida que faltou vira linha', !!rad && rad.pedidos === 1,
      rad ? `pedidos=${rad.pedidos}` : 'não apareceu');
    check('B12 radar: motivo certo (sem_estoque_perto)', !!rad && rad.sem_estoque_perto === 1 && rad.fora_catalogo === 0);
    check('B13 radar: cruza com o galpão (4 un)', !!rad && Number(rad.galpao_qty) === 4,
      rad ? `galpao_qty=${rad.galpao_qty}` : '');

    // ── B14: período 'today' não vê os facts de ontem? (todos os seeds são de hoje —
    //         checa só que a janela today responde sem erro e inclui os de hoje) ──
    const hoje = await getBotVisao('today', ENV, pool);
    const maricaHoje = hoje.mapa.find((m) => m.municipio === 'Maricá');
    check('B14 janela today responde e enxerga os seeds de hoje',
      (maricaHoje?.chamou ?? 0) >= 2);

    // ── fatia 2: funil + perdas + boca + mais-pedidas + cards novos ──
    check('B15 funil: pedido_criado +1 e frete_calculado +1 (delta)',
      funilDe(depois, 'pedido_criado') === a.funilPedido + 1 &&
      funilDe(depois, 'frete_calculado') === a.funilFrete + 1,
      `pedido ${a.funilPedido}->${funilDe(depois, 'pedido_criado')}, frete ${a.funilFrete}->${funilDe(depois, 'frete_calculado')}`);
    check('B16 perdas: objecao_preco +1 (delta)',
      perdaDe(depois, 'objecao_preco') === a.perdaPreco + 1,
      `${a.perdaPreco}->${perdaDe(depois, 'objecao_preco')}`);
    check('B17 boca: pergunta_parcelamento +1 conversa (delta)',
      bocaDe(depois, 'pergunta_parcelamento') === a.bocaParcelado + 1,
      `${a.bocaParcelado}->${bocaDe(depois, 'pergunta_parcelamento')}`);
    const mt = depois.medidas_top.find((m) => m.medida === MEASURE);
    check('B18 mais-pedidas: medida consultada aparece cruzada com o galpão (4 un)',
      !!mt && mt.consultas >= 1 && Number(mt.galpao_qty) === 4,
      mt ? `consultas=${mt.consultas} galpao=${mt.galpao_qty}` : 'não apareceu');
    check('B19 cards ganharam faturamento/ticket_medio/resposta_seg',
      !!depois.cards && 'faturamento' in depois.cards && 'ticket_medio' in depois.cards
        && 'resposta_seg' in depois.cards);

    // ── B20 (redesign 07-12): respondidas_bot_48h vem do SERVIDOR com régua
    //    FIXA de 48h — o turn delivered do B3 (conv1) é a ÚNICA conversa nova
    //    respondida → delta exato +1, independente do período selecionado. ──
    check('B20 cards.respondidas_bot_48h: turn delivered vira +1 conversa (delta)',
      Number(depois.cards?.respondidas_bot_48h) === a.respondidas48h + 1,
      `antes=${a.respondidas48h} depois=${depois.cards?.respondidas_bot_48h}`);

    console.log(fails === 0 ? '\n[VERDE] 20/20 — tela do Bot (fatias 1+2) provada.' : `\n[VERMELHO] ${fails} check(s) falharam.`);
    process.exitCode = fails === 0 ? 0 : 1;
  } finally {
    await limpar();
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[ERRO]', err);
  process.exit(1);
});
