/**
 * Skill `responder_logistica` — frete, entrega, prazo, retirada.
 *
 * Quando: cliente pergunta sobre logística ("vc entrega?", "qual prazo?", "deixa em X?").
 *
 * Tools típicas: calcularFrete (quando bairro identificavel).
 *
 * Exemplos focados (2):
 *   7. Frete coloquial SEM endereço identificado
 *   8. Frete confirmado (SEMPRE inclui municipio junto com bairro)
 */

export const SKILL_RESPONDER_LOGISTICA_EXAMPLES = [
  '# Exemplos da skill responder_logistica',
  '',
  '# REGRA DE GEO-CONFIRMACAO (critica):',
  'SEMPRE inclua o municipio (cidade) retornado pelo calcularFrete junto com o',
  'bairro quando responder sobre entrega. Formato natural: "[bairro], [municipio]"',
  'ou "no [bairro], [municipio]". Isso resolve 3 coisas de uma vez:',
  '  (a) cliente confirma/corrige geografia automaticamente — se a cidade vier',
  '      errada (ex.: cliente eh "Fonseca-SP" mas banco retornou "Fonseca-Niteroi"),',
  '      cliente ve no ato e corrige antes de fechar.',
  '  (b) elimina perguntas tipo "vc sabe onde fica?" — bot ja mostrou que sabe.',
  '  (c) soa mais profissional, confianca aumenta.',
  '',
  'O dado vem do output do calcularFrete: campo `municipio`. NAO INVENTE municipio.',
  'Se municipio veio null da tool, cite so o bairro e flag pro cliente que precisa',
  'confirmar a cidade.',
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
  '## Exemplo 8 — Frete confirmado (com municipio sempre citado)',
  'Customer: "Vou pegar no Centro. Cobra quanto pra entregar?"',
  'tool_results: calcularFrete (bairro_canonico="centro", municipio="Rio de Janeiro", valor=R$15, disponivel=true)',
  '{',
  '  "say": "Pro Centro, Rio de Janeiro, a entrega fica R$ 15,00 e chega em 1 dia útil. Posso anotar o endereço pra você?",',
  '  "actions": [ update_slot global bairro="Centro", update_slot global municipio="Rio de Janeiro" ],',
  '  "claims": [ { "type": "delivery_fee", "amount": 15 } ],',
  '  "rationale": "Frete calculado e disponivel. Cito bairro+municipio (regra de geo-confirmacao). Cliente ve a cidade e corrige se for outra. Slot global municipio registrado."',
  '}',
  '',
  '## Exemplo 8b — Frete confirmado em bairro de cidade da Baixada',
  'Customer: "vcs entregam aqui em Laranjal?"',
  'tool_results: calcularFrete (bairro_canonico="laranjal", municipio="São Gonçalo", valor=R$9,90, disponivel=true, prazo=1)',
  '{',
  '  "say": "Entregamos sim no Laranjal, São Gonçalo. Frete R$ 9,90 e prazo de 1 dia útil. Se quiser, ja me passa o endereco certinho pra seguir.",',
  '  "actions": [ update_slot global bairro="Laranjal", update_slot global municipio="São Gonçalo" ],',
  '  "claims": [ { "type": "delivery_fee", "amount": 9.9 } ],',
  '  "rationale": "Bairro confirmado, cidade citada. Cliente ve que entendi onde fica (mata categoria de pergunta `sabe onde fica?`)."',
  '}',
].join('\n');
