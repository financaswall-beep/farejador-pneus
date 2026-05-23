'use strict';

/**
 * Mede tamanho real do prompt enviado pra cada LLM:
 * - linhas do arquivo .ts (codigo + texto)
 * - linhas do system prompt real
 * - chars do system prompt real
 * - tokens estimados (aprox: chars / 4)
 *
 * Sem dependencias extras. Importa os arquivos compilados de dist/.
 */

const path = require('path');

async function loadPrompts() {
  const toUrl = (rel) => 'file:///' + path.resolve(rel).replace(/\\/g, '/');
  const v15 = await import(toUrl('dist/atendente/generator/prompt-v1_5.js'));
  const planner = await import(toUrl('dist/atendente/planner/prompt.js'));
  const organizadora = await import(toUrl('dist/organizadora/prompt.js'));
  const v14 = await import(toUrl('dist/atendente/generator/prompt.js'));
  return { v15, planner, organizadora, v14 };
}

function buildMockContext() {
  // Mock minimo pra rodar buildGeneratorMessages*
  return {
    environment: 'prod',
    conversation_id: '00000000-0000-4000-8000-000000000001',
    recent_messages: [],
    organizer_facts: { facts: [], summary: null },
    state: { turn_index: 0, global_slots: {}, items: [], drafts: [] },
    last_n_facts: [],
    organizer_context: null,
  };
}

function buildMockDecision() {
  return {
    output: {
      skill: 'responder_geral',
      missing_slots: [],
      tool_requests: [],
      risk_flags: [],
      confidence: 0.9,
      rationale: 'mock',
      prompt_version: 'planner_v1.2.8',
    },
    used_llm: false,
    fallback_used: false,
    duration_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    model: 'mock',
  };
}

function size(content) {
  const lines = content.split('\n').length;
  const chars = content.length;
  const tokensApprox = Math.ceil(chars / 4);
  return { lines, chars, tokensApprox };
}

async function main() {
  const { v15, planner, organizadora, v14 } = await loadPrompts();
  const ctx = buildMockContext();
  const dec = buildMockDecision();

  console.log('=== TAMANHO DOS PROMPTS ===\n');

  // Generator v1.5
  const v15Msgs = v15.buildGeneratorMessagesFewShot(ctx, dec, []);
  const v15Sys = v15Msgs[0].content;
  const v15S = size(v15Sys);
  console.log(`Generator v1.5 (system prompt — few-shot):`);
  console.log(`  linhas:  ${v15S.lines}`);
  console.log(`  chars:   ${v15S.chars}`);
  console.log(`  tokens~: ${v15S.tokensApprox}`);
  console.log();

  // Generator v1.4
  const v14Msgs = v14.buildGeneratorMessages(ctx, dec, []);
  const v14Sys = v14Msgs[0].content;
  const v14S = size(v14Sys);
  console.log(`Generator v1.4 (system prompt — declarativo):`);
  console.log(`  linhas:  ${v14S.lines}`);
  console.log(`  chars:   ${v14S.chars}`);
  console.log(`  tokens~: ${v14S.tokensApprox}`);
  console.log();

  // Planner
  const plannerMsgs = planner.buildPlannerMessages(ctx);
  const plannerSys = plannerMsgs[0].content;
  const plannerS = size(plannerSys);
  console.log(`Planner (system prompt):`);
  console.log(`  linhas:  ${plannerS.lines}`);
  console.log(`  chars:   ${plannerS.chars}`);
  console.log(`  tokens~: ${plannerS.tokensApprox}`);
  console.log();

  // Organizadora
  const orgMsgs = organizadora.buildOrganizadoraPrompt([], {});
  const orgSys = orgMsgs[0].content;
  const orgS = size(orgSys);
  console.log(`Organizadora (system prompt):`);
  console.log(`  linhas:  ${orgS.lines}`);
  console.log(`  chars:   ${orgS.chars}`);
  console.log(`  tokens~: ${orgS.tokensApprox}`);
  console.log();

  console.log('--- Tabela resumo ---');
  console.log('prompt          linhas  chars   tokens~');
  console.log(`Generator v1.5  ${String(v15S.lines).padStart(5)}  ${String(v15S.chars).padStart(5)}   ${v15S.tokensApprox}`);
  console.log(`Generator v1.4  ${String(v14S.lines).padStart(5)}  ${String(v14S.chars).padStart(5)}   ${v14S.tokensApprox}`);
  console.log(`Planner         ${String(plannerS.lines).padStart(5)}  ${String(plannerS.chars).padStart(5)}   ${plannerS.tokensApprox}`);
  console.log(`Organizadora    ${String(orgS.lines).padStart(5)}  ${String(orgS.chars).padStart(5)}   ${orgS.tokensApprox}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
