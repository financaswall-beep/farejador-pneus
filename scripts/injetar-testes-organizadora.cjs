#!/usr/bin/env node
'use strict';

/* eslint-disable no-console */

/**
 * Injeta cenarios sinteticos no Chatwoot para validar a Organizadora.
 *
 * Uso recomendado:
 *   node --env-file=.env scripts/injetar-testes-organizadora.cjs --limit=3 --force-ready
 *   node --env-file=.env scripts/injetar-testes-organizadora.cjs --limit=30 --force-ready
 *
 * O script:
 * - cria contato/conversa via API publica do Chatwoot;
 * - envia mensagens incoming como cliente;
 * - espera o webhook normalizar em core.*;
 * - opcionalmente acelera o debounce do job da Organizadora (--force-ready);
 * - espera o job finalizar e lista os fatos atuais extraidos.
 *
 * Nao escreve em raw.* nem core.* diretamente.
 */

const { Pool } = require('pg');

const CHATWOOT_BASE_URL = (process.env.CHATWOOT_PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const INBOX_IDENTIFIER = process.env.CHATWOOT_INBOX_IDENTIFIER || '';
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';
const CHATWOOT_INBOX_ID = Number(process.env.CHATWOOT_INBOX_ID || '1');
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || '';
const ENVIRONMENT = process.env.FAREJADOR_ENV || 'prod';
const DATABASE_URL = process.env.DATABASE_URL;

const args = parseArgs(process.argv.slice(2));
const LIMIT = numberArg(args.limit, 30);
const MESSAGE_DELAY_MS = numberArg(args.messageDelayMs, 700);
const CAPTURE_TIMEOUT_MS = numberArg(args.captureTimeoutMs, 45000);
const JOB_TIMEOUT_MS = numberArg(args.jobTimeoutMs, 180000);
const FORCE_READY = Boolean(args['force-ready']);
const NO_WAIT = Boolean(args['no-wait']);

if (!DATABASE_URL) {
  console.error('[ERRO] DATABASE_URL nao encontrado. Rode com: node --env-file=.env ...');
  process.exit(1);
}

if (ENVIRONMENT !== 'prod' && !args['allow-non-prod']) {
  console.error(`[ERRO] FAREJADOR_ENV=${ENVIRONMENT}.`);
  console.error('       Para evitar mistura acidental, este injetor roda em prod por padrao.');
  console.error('       Se for intencional, passe --allow-non-prod.');
  process.exit(1);
}

const scenarios = [
  {
    id: 'S01-medida-explicita-traseiro',
    name: 'Teste Org 01 Medida',
    messages: ['bom dia', 'meu nome e Joao', 'tem pneu traseiro 100/80-18 pra CG 160?'],
    expected: ['nome_cliente', 'moto_modelo', 'posicao_pneu', 'medida_pneu', 'intencao_cliente'],
  },
  {
    id: 'S02-veiculo-sem-medida',
    name: 'Teste Org 02 Veiculo',
    messages: ['oi', 'preciso de pneu pra Bros 160', 'nao sei a medida'],
    expected: ['moto_modelo', 'intencao_cliente'],
  },
  {
    id: 'S03-entrega-pix',
    name: 'Teste Org 03 Entrega',
    messages: ['sou de Campo Grande', 'voces entregam hoje?', 'se entregar eu fecho no pix'],
    expected: ['bairro_mencionado', 'perguntou_entrega_hoje', 'modalidade_entrega', 'forma_pagamento'],
  },
  {
    id: 'S04-negociacao-concorrente',
    name: 'Teste Org 04 Negociacao',
    messages: ['achei caro', 'tem desconto?', 'o concorrente me fez por 180'],
    expected: ['achou_caro', 'pediu_desconto', 'preco_concorrente'],
  },
  {
    id: 'S05-marcas-preferencia-recusa',
    name: 'Teste Org 05 Marcas',
    messages: ['quero Pirelli ou Michelin', 'nao quero Maggion', 'se tiver outra marca boa pode mandar tambem'],
    expected: ['marca_pneu_preferida', 'marca_pneu_recusada', 'aceita_alternativa', 'preferencia_principal'],
  },
  {
    id: 'S06-correcao-modelo',
    name: 'Teste Org 06 Correcao',
    messages: ['e pra Bros 160', 'na verdade errei, e pra CG 160'],
    expected: ['moto_modelo'],
  },
  {
    id: 'S07-multiplas-medidas',
    name: 'Teste Org 07 Multiplos',
    messages: ['preciso dos dois pneus', 'dianteiro 80/100-18 e traseiro 100/90-18', 'e pra Titan 150'],
    expected: ['quantidade_pneus', 'posicao_pneu', 'medida_pneu', 'moto_modelo'],
  },
  {
    id: 'S08-uso-delivery-urgente',
    name: 'Teste Org 08 Delivery',
    messages: ['trabalho de delivery', 'meu pneu furou agora', 'preciso resolver hoje'],
    expected: ['moto_uso', 'motivo_compra', 'urgencia'],
  },
  {
    id: 'S09-parcelamento',
    name: 'Teste Org 09 Parcelamento',
    messages: ['quanto fica no cartao?', 'parcela em quantas vezes?', 'no pix tem desconto?'],
    expected: ['forma_pagamento', 'perguntou_parcelamento', 'pediu_desconto'],
  },
  {
    id: 'S10-retirada',
    name: 'Teste Org 10 Retirada',
    messages: ['moro no Meier', 'posso retirar na loja?', 'quero pagar em dinheiro'],
    expected: ['bairro_mencionado', 'modalidade_entrega', 'forma_pagamento'],
  },
  {
    id: 'S11-ano-cilindrada',
    name: 'Teste Org 11 Ano',
    messages: ['minha moto e uma XRE 300 2020', 'qual pneu traseiro voces indicam?'],
    expected: ['moto_modelo', 'moto_cilindrada', 'moto_ano', 'posicao_pneu'],
  },
  {
    id: 'S12-duvida-compatibilidade',
    name: 'Teste Org 12 Compat',
    messages: ['90/90-18 serve na Fan 160?', 'nao quero comprar errado'],
    expected: ['medida_pneu', 'moto_modelo', 'intencao_cliente'],
  },
  {
    id: 'S13-garantia',
    name: 'Teste Org 13 Garantia',
    messages: ['comprei um pneu e deu problema', 'como funciona garantia?'],
    expected: ['intencao_cliente'],
  },
  {
    id: 'S14-reclamacao',
    name: 'Teste Org 14 Reclamacao',
    messages: ['fui atendido ontem e ninguem retornou', 'preciso resolver isso'],
    expected: ['intencao_cliente', 'urgencia'],
  },
  {
    id: 'S15-humano',
    name: 'Teste Org 15 Humano',
    messages: ['quero falar com um atendente', 'nao quero bot'],
    expected: ['pediu_humano'],
  },
  {
    id: 'S16-preco-alvo',
    name: 'Teste Org 16 Preco Alvo',
    messages: ['tenho ate 220 reais', 'quero algo bom mas barato'],
    expected: ['faixa_preco_desejada', 'preferencia_principal'],
  },
  {
    id: 'S17-produto-aceito',
    name: 'Teste Org 17 Aceite',
    messages: ['se tiver Technic por 210 eu fico', 'pode separar pra mim'],
    expected: ['marca_pneu_preferida', 'preco_concorrente', 'produto_aceito'],
  },
  {
    id: 'S18-recusa-preco',
    name: 'Teste Org 18 Recusa',
    messages: ['obrigado mas vou deixar pra depois', 'ficou caro pra mim'],
    expected: ['produto_aceito', 'produto_recusado_motivo', 'achou_caro'],
  },
  {
    id: 'S19-comprou-concorrente',
    name: 'Teste Org 19 Perda',
    messages: ['comprei em outra loja', 'la estava mais barato e entregava hoje'],
    expected: ['produto_recusado_motivo', 'achou_caro', 'perguntou_entrega_hoje'],
  },
  {
    id: 'S20-municipio',
    name: 'Teste Org 20 Municipio',
    messages: ['sou de Nova Iguacu', 'entrega aqui tambem?', 'qual valor do frete?'],
    expected: ['municipio_mencionado', 'modalidade_entrega', 'intencao_cliente'],
  },
  {
    id: 'S21-marca-moto',
    name: 'Teste Org 21 Marca Moto',
    messages: ['e uma Yamaha Fazer 250', 'preciso do pneu dianteiro'],
    expected: ['moto_marca', 'moto_modelo', 'moto_cilindrada', 'posicao_pneu'],
  },
  {
    id: 'S22-viagem-seguranca',
    name: 'Teste Org 22 Viagem',
    messages: ['vou viajar sexta', 'meu pneu esta careca', 'quero um de qualidade'],
    expected: ['motivo_compra', 'urgencia', 'preferencia_principal', 'moto_uso'],
  },
  {
    id: 'S23-pouca-informacao',
    name: 'Teste Org 23 Vago',
    messages: ['ola', 'tem pneu?', 'quanto custa?'],
    expected: ['intencao_cliente'],
  },
  {
    id: 'S24-mensagem-unica-densa',
    name: 'Teste Org 24 Denso',
    messages: ['Boa tarde, sou a Carla de Bonsucesso, preciso de pneu traseiro 140/70-17 para Fazer 250, pago no pix e queria entrega hoje.'],
    expected: ['nome_cliente', 'bairro_mencionado', 'medida_pneu', 'moto_modelo', 'posicao_pneu', 'forma_pagamento'],
  },
  {
    id: 'S25-erros-digitacao',
    name: 'Teste Org 25 Digitacao',
    messages: ['prciso pneu trazeiro pra titan', 'axo q medida e 100/80 18', 'tem hj?'],
    expected: ['moto_modelo', 'posicao_pneu', 'medida_pneu', 'perguntou_entrega_hoje'],
  },
  {
    id: 'S26-marca-qualidade',
    name: 'Teste Org 26 Qualidade',
    messages: ['nao quero o mais barato', 'quero durabilidade', 'uso todo dia pra trabalhar'],
    expected: ['preferencia_principal', 'moto_uso'],
  },
  {
    id: 'S27-estoque-hoje',
    name: 'Teste Org 27 Estoque',
    messages: ['tem 110/90-17 em estoque?', 'consigo pegar ainda hoje?'],
    expected: ['medida_pneu', 'intencao_cliente', 'urgencia'],
  },
  {
    id: 'S28-alternativa',
    name: 'Teste Org 28 Alternativa',
    messages: ['queria Michelin', 'se nao tiver pode ser outra marca boa', 'mas nao remold'],
    expected: ['marca_pneu_preferida', 'aceita_alternativa', 'marca_pneu_recusada'],
  },
  {
    id: 'S29-frete-pagamento-misto',
    name: 'Teste Org 29 Frete',
    messages: ['quanto fica pra entregar em Madureira?', 'da pra pagar metade pix metade cartao?'],
    expected: ['bairro_mencionado', 'modalidade_entrega', 'forma_pagamento'],
  },
  {
    id: 'S30-conversa-longa-correcao',
    name: 'Teste Org 30 Longa',
    messages: [
      'boa noite',
      'tenho uma Biz 125',
      'preciso do dianteiro',
      'opa, e traseiro na verdade',
      'medida 80/100-14',
      'quero entregar em Bangu amanha',
      'se for ate 190 no pix eu fecho',
    ],
    expected: ['moto_modelo', 'posicao_pneu', 'medida_pneu', 'bairro_mencionado', 'forma_pagamento', 'faixa_preco_desejada'],
  },
];

function parseArgs(rawArgs) {
  const parsed = {};
  for (const arg of rawArgs) {
    const clean = arg.replace(/^--/, '');
    const eq = clean.indexOf('=');
    if (eq === -1) parsed[clean] = true;
    else parsed[clean.slice(0, eq)] = clean.slice(eq + 1);
  }
  return parsed;
}

function numberArg(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function phoneFor(index, runId) {
  const runSeed = Number(runId.slice(-6)) || Math.floor(Date.now() % 900000);
  const line = 10000000 + ((runSeed * 100 + index) % 89999999);
  return `+55219${String(line).padStart(8, '0')}`;
}

async function publicRequest(method, path, body) {
  const response = await fetch(`${CHATWOOT_BASE_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Chatwoot ${method} ${path} ${response.status}: ${text.slice(0, 300)}`);
  }
  return parsed;
}

async function privateRequest(method, path, body) {
  const response = await fetch(`${CHATWOOT_BASE_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      api_access_token: CHATWOOT_API_TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`Chatwoot ${method} ${path} ${response.status}: ${text.slice(0, 300)}`);
  }
  return parsed;
}

function extractContactId(response) {
  return response?.payload?.contact?.id
    ?? response?.payload?.id
    ?? response?.contact?.id
    ?? response?.data?.id
    ?? response?.id;
}

function extractConversationId(response) {
  return response?.id ?? response?.payload?.id ?? response?.data?.id;
}

async function createPrivateConversation(scenario, index, runId) {
  const contact = await privateRequest('POST', `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`, {
    name: scenario.name,
    phone_number: phoneFor(index, runId),
    custom_attributes: {
      farejador_test: true,
      farejador_test_kind: 'organizadora_matrix',
      farejador_test_run_id: runId,
      scenario_id: scenario.id,
    },
  });
  const contactId = extractContactId(contact);
  if (!contactId) {
    throw new Error(`Nao foi possivel extrair contact id: ${JSON.stringify(contact).slice(0, 300)}`);
  }

  const conversation = await privateRequest('POST', `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`, {
    inbox_id: CHATWOOT_INBOX_ID,
    contact_id: contactId,
    custom_attributes: {
      farejador_test: true,
      farejador_test_kind: 'organizadora_matrix',
      farejador_test_run_id: runId,
      scenario_id: scenario.id,
    },
  });
  const chatwootConversationId = extractConversationId(conversation);
  if (!chatwootConversationId) {
    throw new Error(`Nao foi possivel extrair conversation id: ${JSON.stringify(conversation).slice(0, 300)}`);
  }

  return { mode: 'private', contactId, chatwootConversationId };
}

async function createConversation(scenario, index, runId) {
  if (CHATWOOT_API_TOKEN) {
    return createPrivateConversation(scenario, index, runId);
  }

  const identifier = `farejador-orgtest-${runId}-${String(index).padStart(2, '0')}`;
  const contact = await publicRequest('POST', `/public/api/v1/inboxes/${INBOX_IDENTIFIER}/contacts`, {
    identifier,
    name: scenario.name,
    phone_number: phoneFor(index, runId),
    custom_attributes: {
      farejador_test: true,
      farejador_test_kind: 'organizadora_matrix',
      farejador_test_run_id: runId,
      scenario_id: scenario.id,
    },
  });

  const conversation = await publicRequest(
    'POST',
    `/public/api/v1/inboxes/${INBOX_IDENTIFIER}/contacts/${contact.source_id}/conversations`,
    {
      custom_attributes: {
        farejador_test: true,
        farejador_test_kind: 'organizadora_matrix',
        farejador_test_run_id: runId,
        scenario_id: scenario.id,
      },
    },
  );

  return { mode: 'public', contactSourceId: contact.source_id, chatwootConversationId: conversation.id };
}

async function sendMessage(conversation, content) {
  if (conversation.mode === 'private') {
    return privateRequest(
      'POST',
      `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversation.chatwootConversationId}/messages`,
      { content, message_type: 'incoming', private: false },
    );
  }

  return publicRequest(
    'POST',
    `/public/api/v1/inboxes/${INBOX_IDENTIFIER}/contacts/${conversation.contactSourceId}/conversations/${conversation.chatwootConversationId}/messages`,
    { content },
  );
}

async function waitForCoreConversation(pool, chatwootConversationId) {
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT id, chatwoot_conversation_id
       FROM core.conversations
       WHERE environment = $1
         AND chatwoot_conversation_id = $2
       ORDER BY updated_at DESC
       LIMIT 1`,
      [ENVIRONMENT, chatwootConversationId],
    );
    if (result.rows[0]) return result.rows[0];
    await sleep(1000);
  }
  return null;
}

async function waitForMessageCount(pool, conversationId, expectedCount) {
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM core.messages
       WHERE environment = $1
         AND conversation_id = $2`,
      [ENVIRONMENT, conversationId],
    );
    const row = result.rows[0];
    if (row && row.count >= expectedCount) return row;
    await sleep(1000);
  }
  return null;
}

async function forceJobReady(pool, conversationId) {
  await pool.query(
    `UPDATE ops.enrichment_jobs
     SET not_before = now()
     WHERE environment = $1
       AND conversation_id = $2
       AND job_type = 'organize_conversation'
       AND status IN ('pending', 'queued')`,
    [ENVIRONMENT, conversationId],
  );
}

async function waitForOrganizadoraJob(pool, conversationId) {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT id, status, attempts, last_error, completed_at, last_processed_message_id
       FROM ops.enrichment_jobs
       WHERE environment = $1
         AND conversation_id = $2
         AND job_type = 'organize_conversation'
       ORDER BY created_at DESC
       LIMIT 1`,
      [ENVIRONMENT, conversationId],
    );
    const row = result.rows[0];
    if (row && ['done', 'completed', 'failed', 'skipped'].includes(row.status)) return row;
    await sleep(3000);
  }
  return null;
}

async function readFacts(pool, conversationId) {
  const result = await pool.query(
    `SELECT fact_key, fact_value, truth_type, confidence_level::text AS confidence_level, superseded_by
     FROM analytics.conversation_facts
     WHERE environment = $1
       AND conversation_id = $2
     ORDER BY created_at ASC`,
    [ENVIRONMENT, conversationId],
  );
  return result.rows;
}

function summarizeFacts(facts) {
  const active = facts.filter((fact) => fact.superseded_by === null);
  return active.map((fact) => fact.fact_key);
}

async function main() {
  const selected = scenarios.slice(0, Math.min(LIMIT, scenarios.length));
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 2,
  });

  const results = [];
  console.log(`Rodada Organizadora: ${runId}`);
  console.log(`Cenarios: ${selected.length}/${scenarios.length}`);
  console.log(`Chatwoot: ${CHATWOOT_BASE_URL}`);
  console.log(`API Chatwoot: ${CHATWOOT_API_TOKEN ? 'privada' : 'publica'}`);
  console.log(`Environment: ${ENVIRONMENT}`);
  console.log(`force-ready: ${FORCE_READY ? 'sim' : 'nao'}\n`);

  try {
    for (let i = 0; i < selected.length; i++) {
      const scenario = selected[i];
      const index = i + 1;
      console.log(`[${index}/${selected.length}] ${scenario.id}`);

      const conversation = await createConversation(scenario, index, runId);
      for (const message of scenario.messages) {
        await sendMessage(conversation, message);
        await sleep(MESSAGE_DELAY_MS);
      }

      const coreConversation = await waitForCoreConversation(pool, conversation.chatwootConversationId);
      if (!coreConversation) {
        console.log('  captura: timeout');
        results.push({ scenario: scenario.id, status: 'capture_timeout', chatwootConversationId: conversation.chatwootConversationId });
        continue;
      }

      const messageCount = await waitForMessageCount(pool, coreConversation.id, scenario.messages.length);
      if (!messageCount) {
        console.log('  mensagens: timeout');
      }

      if (FORCE_READY) {
        await forceJobReady(pool, coreConversation.id);
      }

      let job = null;
      if (!NO_WAIT) {
        job = await waitForOrganizadoraJob(pool, coreConversation.id);
      }

      const facts = await readFacts(pool, coreConversation.id);
      const factKeys = summarizeFacts(facts);
      const missingExpected = scenario.expected.filter((key) => !factKeys.includes(key));

      results.push({
        scenario: scenario.id,
        chatwootConversationId: conversation.chatwootConversationId,
        conversationId: coreConversation.id,
        status: job?.status || (NO_WAIT ? 'not_waited' : 'job_timeout'),
        attempts: job?.attempts ?? null,
        error: job?.last_error ?? null,
        factCount: facts.length,
        activeFactKeys: factKeys,
        missingExpected,
      });

      console.log(`  core: ${coreConversation.id}`);
      console.log(`  job: ${job?.status || (NO_WAIT ? 'nao aguardado' : 'timeout')}`);
      console.log(`  fatos ativos: ${factKeys.length ? factKeys.join(', ') : '(nenhum)'}`);
      if (missingExpected.length) console.log(`  esperados ausentes: ${missingExpected.join(', ')}`);
      console.log('');
    }

    const ok = results.filter((row) => row.status === 'done' || row.status === 'completed').length;
    const failed = results.filter((row) => row.status === 'failed').length;
    const timeout = results.filter((row) => row.status.includes('timeout')).length;

    console.log('RESUMO');
    console.log(`  run_id: ${runId}`);
    console.log(`  concluidos: ${ok}`);
    console.log(`  failed: ${failed}`);
    console.log(`  timeouts: ${timeout}`);
    console.log('\nRESULTADOS_JSON_START');
    console.log(JSON.stringify(results, null, 2));
    console.log('RESULTADOS_JSON_END');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[ERRO]', error.message);
  process.exit(1);
});
