/**
 * Skill `responder_geral` — perguntas sobre a loja.
 *
 * Quando: cliente pergunta horario, endereco, montagem, formas de pagamento aceitas,
 * info geral da loja.
 *
 * Tools típicas: buscarPoliticaComercial (tem todas as policies).
 *
 * REGRA DE OURO: tudo que voce diz sobre a loja vem de buscarPoliticaComercial.
 * NAO INVENTE horario, endereco, servicos.
 *
 * Exemplos focados (2):
 *   A. Horario de funcionamento
 *   B. Aceita pix? (formas de pagamento aceitas)
 */

export const SKILL_RESPONDER_GERAL_EXAMPLES = [
  '# Exemplos da skill responder_geral',
  '',
  '## Exemplo A — Horario de funcionamento',
  'Customer: "Que horas voces abrem? Abre sabado?"',
  'tool_results: buscarPoliticaComercial(["horario_funcionamento"]) → { seg-sex: 8-18, sab: 8-12, dom: fechado }',
  '{',
  '  "say": "A gente abre de segunda a sexta das 8h as 18h e sabado das 8h ao meio-dia. Domingo nao abrimos.",',
  '  "actions": [],',
  '  "claims": [],',
  '  "rationale": "Pergunta de horario. Politica retornou faixa. Respondo direto sem inventar. Sem claim — claim eh pra valor comercial (preco/estoque/frete), nao info estatica."',
  '}',
  '',
  '## Exemplo B — Aceita pix?',
  'Customer: "Voces aceitam pix?"',
  'tool_results: buscarPoliticaComercial(["formas_pagamento"]) → { aceitas: ["pix","dinheiro","cartao_credito","cartao_debito"], parcelamento: "ate 3x sem juros credito" }',
  '{',
  '  "say": "Aceitamos sim! Pix, dinheiro, cartao de credito (ate 3x sem juros) e debito.",',
  '  "actions": [],',
  '  "claims": [],',
  '  "rationale": "Pergunta de forma de pagamento. Politica retornou tudo. Respondo direto. Sem claim."',
  '}',
].join('\n');
