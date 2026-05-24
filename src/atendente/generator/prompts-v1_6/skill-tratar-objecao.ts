/**
 * Skill `tratar_objecao` — cliente resistindo (preco, comparacao, hesitacao).
 *
 * Quando: cliente diz "ta caro", "achei mais barato no concorrente", "tem desconto?",
 * "vou pensar", "ta acima do orcamento".
 *
 * Tools típicas: buscarPoliticaComercial (quando objecao envolve desconto/parcelamento).
 *
 * REGRA DE OURO: NUNCA inventar desconto. Se buscarPoliticaComercial nao retornar
 * desconto liberado, voce nao TEM desconto.
 *
 * Exemplos focados (3):
 *   A. "Ta caro" sem desconto cadastrado
 *   B. "Tem desconto?" com politica que permite
 *   C. "Vou pensar" (hesitacao)
 */

export const SKILL_TRATAR_OBJECAO_EXAMPLES = [
  '# Exemplos da skill tratar_objecao',
  '',
  '## Exemplo A — "Ta caro" sem politica de desconto',
  'Customer: "Po, ta salgado esse pneu, nao tem como melhorar nao?"',
  'tool_results: buscarPoliticaComercial → sem desconto liberado',
  '{',
  '  "say": "Entendo. O valor que passei eh o que tenho disponivel no momento. Esse pneu costuma durar X km e tem garantia da loja. Se quiser, eu segura ele pra voce hoje sem compromisso ate o final do dia.",',
  '  "actions": [],',
  '  "claims": [],',
  '  "rationale": "Objecao de preco. Politica nao tem desconto. NAO invento valor. Reforco valor agregado e ofereco hold. Sem claim comercial novo."',
  '}',
  '',
  '## Exemplo B — "Tem desconto?" com politica permitindo',
  'Customer: "Consegue fazer um precinho melhor?"',
  'tool_results: buscarPoliticaComercial → desconto_pix_avista=5% liberado',
  '{',
  '  "say": "Posso fazer 5% de desconto se fechar no pix a vista. Te interessa?",',
  '  "actions": [],',
  '  "claims": [],',
  '  "rationale": "Politica retornou 5% pix avista. Cito o desconto da politica. Sem claim de price novo (o desconto ainda nao foi aceito)."',
  '}',
  '',
  '## Exemplo C — Hesitacao "vou pensar"',
  'Customer: "Vou pensar e te falo depois"',
  'tool_results: NENHUMA.',
  '{',
  '  "say": "Tranquilo, fica a vontade. Se quiser, posso te guardar a cotacao pelo dia de hoje. Qualquer coisa, eh so me chamar.",',
  '  "actions": [],',
  '  "claims": [],',
  '  "rationale": "Hesitacao. Aceito sem forçar, ofereco hold opcional. Sem claim — sem afirmacao comercial nova."',
  '}',
].join('\n');
