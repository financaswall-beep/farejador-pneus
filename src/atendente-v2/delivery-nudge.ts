/**
 * Empurrão determinístico de ENTREGA-PELO-PINO (primo do nudge do pino e do de localização).
 *
 * Furo observado (conversa #696, Wallace 07-01): o cliente mandou o pino, o bot usou pra
 * medir a RETIRADA (21 km), mas quando o cliente escolheu ENTREGA o bot travou pedindo "rua,
 * número e bairro" — como se precisasse do endereço escrito só pra COTAR o frete, já tendo a
 * coordenada. A raiz MECÂNICA era o calcular_frete exigir bairro (corrigido: a flag
 * DELIVERY_FREIGHT_FROM_PIN torna o bairro opcional e cota pelo pino). Este empurrão garante o
 * COMPORTAMENTO: cotar primeiro, endereço por último (§3 — comportamento crítico por código,
 * não por prompt solto).
 *
 * Gatilho: o cliente ESCOLHEU entrega (na última fala dele) E há pino. Sem os dois, devolve
 * vazio (não muda o system prompt → preserva o prompt caching). Gating pela flag fica no
 * agent.ts (com a flag off a instrução "chame calcular_frete sem bairro" não teria efeito —
 * o schema ainda exigiria bairro).
 */

// "entrega", "entregar", "entregue", "entreguem"… — a escolha do cliente pela entrega.
const DELIVERY_CHOICE_RE = /entreg/i;
// Palavras de RETIRADA que, se presentes, indicam que ele NÃO escolheu entrega
// (ex.: "não, vou retirar", "prefiro buscar", "eu passo aí e pego"). Evita falso positivo.
const PICKUP_WORDS_RE = /retir|buscar|busco|vou a[íi]|passo a[íi]|pego a[íi]|pegar a[íi]/i;

/**
 * O cliente escolheu ENTREGA na última mensagem dele? Conservador: exige a palavra de
 * entrega e a AUSÊNCIA de palavra de retirada (pra "não quero entrega, vou buscar" não
 * disparar). Detecção por texto do cliente é aproximada — por isso o nudge é PERMISSIVO.
 */
export function customerChoseDelivery(latestCustomerText: string | null | undefined): boolean {
  if (!latestCustomerText) return false;
  if (PICKUP_WORDS_RE.test(latestCustomerText)) return false;
  return DELIVERY_CHOICE_RE.test(latestCustomerText);
}

export const DELIVERY_QUOTE_FIRST_NUDGE = `

[CLIENTE ESCOLHEU ENTREGA E VOCÊ JÁ TEM A LOCALIZAÇÃO 📍] Você tem o pino do cliente — NÃO precisa do endereço escrito pra cotar o frete. Então:
- SE ainda não cotou o frete: chame calcular_frete AGORA (SEM passar "bairro" — o sistema resolve a loja e o valor pela localização) e informe o frete, seguindo pro fechamento.
- Peça a rua e o número só no FECHAMENTO, como detalhe pro entregador achar a porta — NUNCA como condição pra cotar o frete ou pra continuar. NÃO trave a venda exigindo o endereço antes de cotar.
- NUNCA diga que precisa do endereço "pra calcular" o frete: você calcula pela localização que já recebeu.`;

/**
 * Monta o empurrão a anexar ao system prompt. Vazio (não muda o prompt) a menos que o
 * cliente tenha escolhido entrega E exista pino. O agent.ts só chama isto com a flag on.
 */
export function buildDeliveryQuoteFirstNudge(
  latestCustomerText: string | null | undefined,
  hasPin: boolean,
): string {
  if (!hasPin) return '';
  return customerChoseDelivery(latestCustomerText) ? DELIVERY_QUOTE_FIRST_NUDGE : '';
}
