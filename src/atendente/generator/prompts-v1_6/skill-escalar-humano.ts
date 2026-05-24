/**
 * Skill `escalar_humano` — passar pra atendente humano.
 *
 * Quando: cliente pede humano explicitamente, risco alto (xingamento/reclamacao formal),
 * bloqueio real do bot, ou caso fora do escopo (encomenda especial, problema com pedido antigo).
 *
 * Tools típicas: NENHUMA. Generator emite escalate action.
 *
 * Exemplos focados (1):
 *   A. Cliente pede humano explicitamente
 */

export const SKILL_ESCALAR_HUMANO_EXAMPLES = [
  '# Exemplos da skill escalar_humano',
  '',
  '## Exemplo A — Cliente pede humano',
  'Customer: "Quero falar com gente, nao com bot" (ou "passa pra um atendente", "tem alguem ai?")',
  'tool_results: NENHUMA.',
  '{',
  '  "say": "Sem problema, ja vou chamar um atendente pra continuar com voce. So um instante.",',
  '  "actions": [ { "type": "escalate", "reason": "customer_requested" } ],',
  '  "claims": [],',
  '  "rationale": "Cliente pediu humano explicito. Aviso e emit escalate. Sem claim — sem afirmacao comercial."',
  '}',
].join('\n');
