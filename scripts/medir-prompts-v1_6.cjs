'use strict';

/**
 * Mede tamanho do Generator v1.6 (Modular) por skill.
 * Compara cada skill vs v1.5 monolitico.
 */

const path = require('path');

async function main() {
  const toUrl = (rel) => 'file:///' + path.resolve(rel).replace(/\\/g, '/');
  const v16 = await import(toUrl('dist/atendente/generator/prompt-v1_6.js'));
  const v15 = await import(toUrl('dist/atendente/generator/prompt-v1_5.js'));
  const common = await import(toUrl('dist/atendente/generator/prompts-v1_6/common.js'));

  function size(content) {
    const chars = content.length;
    const lines = content.split('\n').length;
    const tokens = Math.ceil(chars / 4);
    return { chars, lines, tokens };
  }

  // Mock context pra buildGeneratorMessagesModular
  const ctx = {
    environment: 'prod',
    conversation_id: '00000000-0000-4000-8000-000000000001',
    recent_messages: [],
    organizer_facts: { facts: [], summary: null },
    state: { turn_index: 0, global_slots: {}, items: [], drafts: [] },
    last_n_facts: [],
    organizer_context: null,
  };

  function buildDecision(skill) {
    return {
      output: {
        skill,
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

  console.log('=== GENERATOR v1.6 MODULAR — SIZE POR SKILL ===\n');

  // v1.5 baseline
  const v15Msgs = v15.buildGeneratorMessagesFewShot(ctx, buildDecision('buscar_e_ofertar'), []);
  const v15Sys = size(v15Msgs[0].content);
  console.log('Baseline v1.5 (monolitico):');
  console.log(`  linhas=${v15Sys.lines}  chars=${v15Sys.chars}  tokens~${v15Sys.tokens}`);
  console.log();

  // common só
  const commonSize = size(common.COMMON_BLOCK);
  console.log('v1.6 COMMON BLOCK (sempre incluido):');
  console.log(`  linhas=${commonSize.lines}  chars=${commonSize.chars}  tokens~${commonSize.tokens}`);
  console.log();

  // cada skill
  console.log('v1.6 POR SKILL (common + skill examples):');
  console.log('-'.repeat(80));
  const skills = [
    'buscar_e_ofertar',
    'registrar_intencao_fechamento',
    'responder_logistica',
    'pedir_dados_faltantes',
    'tratar_objecao',
    'responder_geral',
    'escalar_humano',
  ];
  const results = [];
  for (const skill of skills) {
    const msgs = v16.buildGeneratorMessagesModular(ctx, buildDecision(skill), []);
    const s = size(msgs[0].content);
    const examplesOnly = size(v16.SKILL_EXAMPLES_MAP[skill]);
    results.push({ skill, total: s, examples: examplesOnly });
    console.log(`  ${skill.padEnd(35)} total=${String(s.tokens).padStart(5)} tok  (examples=${examplesOnly.tokens} tok, common=${commonSize.tokens} tok)`);
  }
  console.log('-'.repeat(80));

  // medias e comparacao
  const avgTokens = results.reduce((s, r) => s + r.total.tokens, 0) / results.length;
  const maxTokens = Math.max(...results.map((r) => r.total.tokens));
  const minTokens = Math.min(...results.map((r) => r.total.tokens));
  const reductionAvg = Math.round((1 - avgTokens / v15Sys.tokens) * 100);
  const reductionMax = Math.round((1 - maxTokens / v15Sys.tokens) * 100);

  console.log();
  console.log('=== RESUMO ===');
  console.log(`v1.5 monolitico (todas skills): ${v15Sys.tokens} tokens`);
  console.log(`v1.6 modular media:             ${Math.round(avgTokens)} tokens (-${reductionAvg}%)`);
  console.log(`v1.6 modular maximo:            ${maxTokens} tokens (-${reductionMax}%)`);
  console.log(`v1.6 modular minimo:            ${minTokens} tokens`);
  console.log();
  console.log('Meta: 50% reducao. Atingida na MEDIA?', reductionAvg >= 50 ? 'SIM ✓' : `NAO (${reductionAvg}%)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
