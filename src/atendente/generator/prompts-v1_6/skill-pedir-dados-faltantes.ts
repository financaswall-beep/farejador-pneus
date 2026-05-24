/**
 * Skill `pedir_dados_faltantes` — cliente quer comprar mas falta dado essencial.
 *
 * Quando: cliente disse "quero um pneu" sem moto/medida, ou Planner reconheceu
 * gap de slot crítico.
 *
 * Tools típicas: NENHUMA. Generator pergunta o slot direto.
 *
 * IMPORTANTE: nao confundir com Ex 2 de buscar_e_ofertar (a skill correta quando
 * eh sem ano mas tem outras info). Pedir_dados_faltantes eh quando nao tem
 * dado suficiente nem pra TENTAR.
 *
 * Exemplos focados (2):
 *   A. Falta moto inteira ("to procurando pneu")
 *   B. Tem moto + medida mas falta posicao
 */

export const SKILL_PEDIR_DADOS_FALTANTES_EXAMPLES = [
  '# Exemplos da skill pedir_dados_faltantes',
  '',
  '## Exemplo A — Cliente sem moto e sem medida',
  'Customer: "Boa, to procurando pneu" (ou "quero um pneu novo", "quanto custa um pneu?")',
  'tool_results: NENHUMA. Nao da pra buscar sem dado nenhum.',
  '{',
  '  "say": "Pra te ajudar certo, me passa qual moto e o ano. Se souber a medida atual do pneu (escrita na lateral), ainda melhor.",',
  '  "actions": [],',
  '  "claims": [],',
  '  "rationale": "Pergunta sem dado. Pede moto+ano+medida. Sem afirmar nada comercial."',
  '}',
  '',
  '## Exemplo B — Cliente disse moto+medida mas nao a posicao (front/rear)',
  'Customer: "Tenho Fan 2019, quero 90/90-18"',
  'tool_results: depende — pode ja ter buscarCompatibilidade. Mas falta saber se eh front ou rear.',
  '{',
  '  "say": "Pra Fan 2019 o 90/90-18 eh o traseiro original. Confirma que eh esse que voce quer?",',
  '  "actions": [ update_slot item ITEM_A medida_pneu="90/90-18" ],',
  '  "claims": [],',
  '  "rationale": "Cliente deu medida que eh especifica da posicao traseira nessa moto. Confirmo em vez de chutar. Sem claim — nao afirmei preco/estoque ainda."',
  '}',
].join('\n');
