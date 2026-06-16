/**
 * Empurrão determinístico de LOCALIZAÇÃO-EM-TEXTO (gêmeo do nudge do pino).
 *
 * Furo observado (conversa 668, Wallace 06-16): o cliente respondeu a localização
 * em TEXTO ("Irajá próximo ao mercado Guanabara"); o bot ATÉ extraiu "Irajá" e
 * chamou a ferramenta com bairro (estoque confirmou), mas na FALA regrediu —
 * recitou a medida do pneu de novo ("o jogo certo é Dianteiro 80/100-18… esse
 * serve?") e não reconheceu a loja nem avançou. O pino tem empurrão por código;
 * a localização em texto não tinha → o LLM, sem trilho, regrediu.
 *
 * Gatilho por ESTADO do próprio bot (não por adivinhar o bairro no texto do
 * cliente, que seria frágil): "minha mensagem anterior pediu a localização".
 * Quando isso é verdade e NÃO há pino (o pino já tem o seu nudge), injeta-se um
 * empurrão PERMISSIVO — não é roteiro: proíbe só as burrices (re-pedir a
 * localização, recitar o mesmo pneu) e manda SEGUIR o cliente se ele mudou de
 * assunto. Some quando a próxima fala do bot não for mais um pedido de localização.
 */

/**
 * A mensagem do bot pediu a localização/endereço do cliente? Casa as frases reais
 * do prompt ("me manda tua localização 📍", "rua, número e o bairro") e evita
 * falsos como "te passo a localização da loja" (envio na retirada, não pedido).
 */
const LOCATION_ASK_RE = /(tua|sua|teu|seu)\s+localiza|manda.{0,25}localiza|rua,?\s*n[úu]mero/i;

export function botAskedForLocation(lastAssistantText: string | null | undefined): boolean {
  if (!lastAssistantText) return false;
  return LOCATION_ASK_RE.test(lastAssistantText);
}

export const LOCATION_REPLY_NUDGE = `

[VOCÊ JÁ PEDIU A LOCALIZAÇÃO NESTA CONVERSA] Sua mensagem anterior pediu a localização/endereço do cliente e ele acabou de responder. Então:
- SE a resposta tem um bairro ou endereço (ex.: "Irajá", "Madureira", "rua tal, 100"): você JÁ TEM a localização — NÃO peça de novo e NÃO repita a medida/preço do pneu que você já falou. Extraia o bairro, use as ferramentas passando "bairro" pra confirmar a loja mais perto, RECONHEÇA essa loja e AVANCE (ex.: "achei a loja pertinho de [bairro] — quer entrega ou retirada?").
- SE o cliente mudou de assunto (trocou de pneu/moto, perguntou preço ou outra coisa): siga o cliente normalmente. Isto NÃO é um roteiro fixo — atenda o que ele pediu.`;

/**
 * Monta o empurrão a anexar ao system prompt. Vazio (não muda o prompt → preserva
 * o caching) a menos que o bot tenha acabado de pedir a localização e NÃO haja pino
 * (o pino já tem o seu próprio nudge). `hasPin` true → não anexa (evita conflito).
 */
export function buildLocationReplyNudge(lastAssistantText: string | null | undefined, hasPin: boolean): string {
  if (hasPin) return '';
  return botAskedForLocation(lastAssistantText) ? LOCATION_REPLY_NUDGE : '';
}
