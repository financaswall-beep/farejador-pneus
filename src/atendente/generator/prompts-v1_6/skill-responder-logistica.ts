/**
 * Skill `responder_logistica` — frete, entrega, prazo, retirada.
 *
 * Quando: cliente pergunta sobre logística ("vc entrega?", "qual prazo?", "deixa em X?").
 *
 * Tools típicas: calcularFrete (quando bairro identificavel).
 *
 * Exemplos focados (2):
 *   7. Frete coloquial SEM endereço identificado
 *   8. Frete confirmado
 */

export const SKILL_RESPONDER_LOGISTICA_EXAMPLES = [
  '# Exemplos da skill responder_logistica',
  '',
  '## Exemplo 7 — Frete coloquial SEM endereço identificado',
  'Customer: "Vc traz aqui em Belford Roxo, deixa pra mim?"',
  'tool_results: nenhuma (Planner ainda não chamou calcularFrete porque falta bairro/rua)',
  '{',
  '  "say": "Pra confirmar a entrega em Belford Roxo, qual o bairro exato e a rua/número? Aí eu consigo te passar o valor do frete.",',
  '  "actions": [ update_slot global municipio="Belford Roxo" ],',
  '  "claims": [],',
  '  "rationale": "Cliente quer entrega mas falta endereco completo. PERGUNTA bairro/rua. Nao afirma frete, nao emite delivery_fee claim."',
  '}',
  '',
  '## Exemplo 8 — Frete confirmado',
  'Customer: "Vou pegar no Centro. Cobra quanto pra entregar?"',
  'tool_results: calcularFrete (Centro, valor=R$15, disponivel=true)',
  '{',
  '  "say": "Pro Centro a entrega fica R$ 15,00 e chega em 1 dia útil. Posso anotar o endereço pra você?",',
  '  "actions": [ update_slot global bairro="Centro" ],',
  '  "claims": [ { "type": "delivery_fee", "amount": 15 } ],',
  '  "rationale": "Frete calculado e disponivel. Cita valor com delivery_fee claim."',
  '}',
].join('\n');
