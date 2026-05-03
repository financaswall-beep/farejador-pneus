#!/usr/bin/env node
'use strict';

/* eslint-disable no-console */

const { Pool } = require('pg');
const { organizadoraEvalCases } = require('./organizadora-eval-cases.cjs');

const args = parseArgs(process.argv.slice(2));
const DATABASE_URL = process.env.DATABASE_URL;
const CHATWOOT_BASE_URL = (process.env.CHATWOOT_PUBLIC_BASE_URL || 'http://76.13.164.152').replace(/\/$/, '');
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';
const CHATWOOT_INBOX_ID = Number(process.env.CHATWOOT_INBOX_ID || '1');
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || '';
const ENVIRONMENT = process.env.FAREJADOR_ENV || 'prod';

const LIMIT = numberArg(args.limit, organizadoraEvalCases.length);
const MESSAGE_DELAY_MS = numberArg(args.messageDelayMs, 250);
const CAPTURE_TIMEOUT_MS = numberArg(args.captureTimeoutMs, 60000);
const JOB_TIMEOUT_MS = numberArg(args.jobTimeoutMs, 240000);
const POLL_MS = numberArg(args.pollMs, 3000);
const FORCE_READY = args['force-ready'] !== false;

if (!DATABASE_URL) {
  console.error('[ERRO] DATABASE_URL ausente.');
  process.exit(1);
}

if (!CHATWOOT_API_TOKEN) {
  console.error('[ERRO] CHATWOOT_API_TOKEN ausente.');
  process.exit(1);
}

if (ENVIRONMENT !== 'prod' && !args['allow-non-prod']) {
  console.error(`[ERRO] FAREJADOR_ENV=${ENVIRONMENT}. Passe --allow-non-prod se isso for intencional.`);
  process.exit(1);
}

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

async function chatwootRequest(method, path, body) {
  const response = await fetch(`${CHATWOOT_BASE_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      api_access_token: CHATWOOT_API_TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
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

async function createConversation(testCase, index, runId) {
  const contact = await chatwootRequest('POST', `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`, {
    name: `Org Baseline ${String(index).padStart(2, '0')}`,
    phone_number: phoneFor(index, runId),
    custom_attributes: {
      farejador_test: true,
      farejador_test_kind: 'organizadora_baseline',
      farejador_test_run_id: runId,
      scenario_id: testCase.id,
    },
  });
  const contactId = extractContactId(contact);
  if (!contactId) throw new Error(`Contato sem id: ${JSON.stringify(contact).slice(0, 300)}`);

  const conversation = await chatwootRequest('POST', `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`, {
    inbox_id: CHATWOOT_INBOX_ID,
    contact_id: contactId,
    custom_attributes: {
      farejador_test: true,
      farejador_test_kind: 'organizadora_baseline',
      farejador_test_run_id: runId,
      scenario_id: testCase.id,
    },
  });
  const chatwootConversationId = extractConversationId(conversation);
  if (!chatwootConversationId) {
    throw new Error(`Conversa sem id: ${JSON.stringify(conversation).slice(0, 300)}`);
  }
  return { contactId, chatwootConversationId };
}

async function sendMessage(conversation, content) {
  return chatwootRequest(
    'POST',
    `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversation.chatwootConversationId}/messages`,
    { content, message_type: 'incoming', private: false },
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
       ORDER BY created_at DESC
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
    if (result.rows[0]?.count >= expectedCount) return true;
    await sleep(1000);
  }
  return false;
}

async function forceJobsReady(pool, conversationIds) {
  if (conversationIds.length === 0) return;
  await pool.query(
    `UPDATE ops.enrichment_jobs
     SET not_before = now()
     WHERE environment = $1
       AND conversation_id = ANY($2::uuid[])
       AND job_type = 'organize_conversation'
       AND status IN ('pending', 'queued')`,
    [ENVIRONMENT, conversationIds],
  );
}

async function waitForJobs(pool, conversationIds) {
  const pending = new Set(conversationIds);
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < deadline && pending.size > 0) {
    const result = await pool.query(
      `SELECT conversation_id, status
       FROM ops.enrichment_jobs
       WHERE environment = $1
         AND conversation_id = ANY($2::uuid[])
         AND job_type = 'organize_conversation'`,
      [ENVIRONMENT, Array.from(pending)],
    );
    for (const row of result.rows) {
      if (['done', 'completed', 'failed', 'skipped'].includes(row.status)) {
        pending.delete(row.conversation_id);
      }
    }
    if (pending.size > 0) await sleep(POLL_MS);
  }
  return pending;
}

async function readJob(pool, conversationId) {
  const result = await pool.query(
    `SELECT id, status, attempts, last_error, completed_at
     FROM ops.enrichment_jobs
     WHERE environment = $1
       AND conversation_id = $2
       AND job_type = 'organize_conversation'
     ORDER BY created_at DESC
     LIMIT 1`,
    [ENVIRONMENT, conversationId],
  );
  return result.rows[0] ?? null;
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

function activeFactKeys(facts) {
  return [...new Set(facts.filter((fact) => fact.superseded_by === null).map((fact) => fact.fact_key))].sort();
}

function scoreCase(testCase, factKeys, job) {
  const missingRequired = testCase.required.filter((key) => !factKeys.includes(key));
  const missingOptional = testCase.optional.filter((key) => !factKeys.includes(key));
  const forbiddenFound = testCase.forbidden.filter((key) => factKeys.includes(key));
  const optionalFound = testCase.optional.filter((key) => factKeys.includes(key));
  const zeroFacts = factKeys.length === 0;
  const zeroFactsOk = zeroFacts && testCase.allowZeroFacts;
  const failed = job?.status !== 'done'
    || missingRequired.length > 0
    || forbiddenFound.length > 0
    || (zeroFacts && !testCase.allowZeroFacts);

  return {
    passed: !failed || zeroFactsOk,
    missingRequired,
    missingOptional,
    optionalFound,
    forbiddenFound,
    zeroFacts,
    zeroFactsOk,
  };
}

function estimatePromptTokens(testCase) {
  const fixedPromptTokens = 1350;
  const transcript = testCase.messages
    .map((message, index) => `[msg_id: uuid-${index}] CLIENTE: ${message}`)
    .join('\n');
  return fixedPromptTokens + Math.ceil(transcript.length / 4);
}

function summarize(rows) {
  const totals = {
    cases: rows.length,
    passed: rows.filter((row) => row.score.passed).length,
    failed: rows.filter((row) => !row.score.passed).length,
    jobsDone: rows.filter((row) => row.jobStatus === 'done').length,
    jobsFailed: rows.filter((row) => row.jobStatus === 'failed').length,
    jobsMissingOrTimeout: rows.filter((row) => !row.jobStatus || row.jobStatus === 'timeout').length,
    zeroFacts: rows.filter((row) => row.score.zeroFacts).length,
    zeroFactsOk: rows.filter((row) => row.score.zeroFactsOk).length,
    avgEstimatedPromptTokens: Math.round(rows.reduce((sum, row) => sum + row.estimatedPromptTokens, 0) / Math.max(rows.length, 1)),
  };

  const missingByKey = {};
  const forbiddenByKey = {};
  for (const row of rows) {
    for (const key of row.score.missingRequired) missingByKey[key] = (missingByKey[key] ?? 0) + 1;
    for (const key of row.score.forbiddenFound) forbiddenByKey[key] = (forbiddenByKey[key] ?? 0) + 1;
  }

  return {
    totals,
    missingByKey: Object.entries(missingByKey).sort((a, b) => b[1] - a[1]),
    forbiddenByKey: Object.entries(forbiddenByKey).sort((a, b) => b[1] - a[1]),
  };
}

async function main() {
  const selected = organizadoraEvalCases.slice(0, Math.min(LIMIT, organizadoraEvalCases.length));
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 2,
  });

  const injected = [];
  console.log(`Baseline Organizadora ${runId}`);
  console.log(`Casos: ${selected.length}/${organizadoraEvalCases.length}`);
  console.log(`Chatwoot: ${CHATWOOT_BASE_URL}`);
  console.log(`Environment: ${ENVIRONMENT}\n`);

  try {
    for (let i = 0; i < selected.length; i++) {
      const testCase = selected[i];
      const index = i + 1;
      console.log(`[inject ${index}/${selected.length}] ${testCase.id}`);
      const conversation = await createConversation(testCase, index, runId);
      for (const message of testCase.messages) {
        await sendMessage(conversation, message);
        await sleep(MESSAGE_DELAY_MS);
      }

      const coreConversation = await waitForCoreConversation(pool, conversation.chatwootConversationId);
      if (!coreConversation) {
        injected.push({ testCase, chatwootConversationId: conversation.chatwootConversationId, conversationId: null, captureStatus: 'conversation_timeout' });
        continue;
      }

      const messagesCaptured = await waitForMessageCount(pool, coreConversation.id, testCase.messages.length);
      injected.push({
        testCase,
        chatwootConversationId: conversation.chatwootConversationId,
        conversationId: coreConversation.id,
        captureStatus: messagesCaptured ? 'captured' : 'message_timeout',
      });
    }

    const conversationIds = injected.filter((row) => row.conversationId).map((row) => row.conversationId);
    if (FORCE_READY) await forceJobsReady(pool, conversationIds);

    console.log(`\nAguardando jobs da Organizadora (${conversationIds.length})...`);
    const timedOut = await waitForJobs(pool, conversationIds);
    if (timedOut.size > 0) {
      console.log(`Jobs em timeout: ${Array.from(timedOut).join(', ')}`);
    }

    const rows = [];
    for (const item of injected) {
      const job = item.conversationId ? await readJob(pool, item.conversationId) : null;
      const facts = item.conversationId ? await readFacts(pool, item.conversationId) : [];
      const factKeys = activeFactKeys(facts);
      const jobStatus = job?.status ?? (item.conversationId ? 'timeout' : null);
      const score = scoreCase(item.testCase, factKeys, job);
      rows.push({
        id: item.testCase.id,
        name: item.testCase.name,
        chatwootConversationId: item.chatwootConversationId,
        conversationId: item.conversationId,
        captureStatus: item.captureStatus,
        jobStatus,
        attempts: job?.attempts ?? null,
        lastError: job?.last_error ?? null,
        factKeys,
        required: item.testCase.required,
        optional: item.testCase.optional,
        forbidden: item.testCase.forbidden,
        allowZeroFacts: item.testCase.allowZeroFacts,
        estimatedPromptTokens: estimatePromptTokens(item.testCase),
        score,
      });
    }

    const summary = summarize(rows);
    console.log('\nRESUMO_BASELINE');
    console.log(JSON.stringify(summary, null, 2));
    console.log('\nRESULTADOS_JSON_START');
    console.log(JSON.stringify({ runId, summary, rows }, null, 2));
    console.log('RESULTADOS_JSON_END');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[ERRO]', error.message);
  process.exit(1);
});
