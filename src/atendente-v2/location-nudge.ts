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
 * Reconhece pedidos ao cliente, incluindo aberturas antigas já no histórico.
 * A indicação do endereço da loja ou uma confirmação de endereço anterior têm outro fluxo.
 */
const LOCATION_ASK_RE = /(?:tua|sua|teu|seu)\s+localiza|manda.{0,25}localiza|rua,?\s*numero/;
const REQUEST_TO_CUSTOMER = /\b(?:me (?:passa|manda|envia|diz|fala|informa)|(?:pode|consegue|poderia) (?:me )?(?:passar|mandar|enviar|compartilhar|informar))\s+(?:(?:aqui|por aqui|pra mim|por favor|o|a|um|uma|seu|sua|teu|tua)\s+)*(?:endereco|bairro|pino|localizacao)\b(?!\s+d[ao] (?:loja|matriz|parceiro|ultima entrega))/;
const ASK_WHERE = /\b(?:qual (?:e )?(?:(?:o )?(?:seu|teu) (?:endereco|bairro)|(?:a )?(?:sua|tua) localizacao)|(?:em qual bairro|em que bairro|de onde|onde) (?:voce|vc|tu) (?:mora|esta|ta|fica|fala))\b/;

export function botAskedForLocation(lastAssistantText: string | null | undefined): boolean {
  if (!lastAssistantText) return false;
  const text = lastAssistantText.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return LOCATION_ASK_RE.test(text) || REQUEST_TO_CUSTOMER.test(text) || ASK_WHERE.test(text);
}

export const LOCATION_REPLY_NUDGE = `

[VOCÊ JÁ PEDIU A LOCALIZAÇÃO NESTA CONVERSA] Sua mensagem anterior pediu a localização/endereço do cliente e ele acabou de responder. Então:
- SE a resposta tem um bairro ou endereço (ex.: "Irajá", "Madureira", "rua tal, 100"): você JÁ TEM a localização — NÃO peça de novo. Extraia o bairro e use a ferramenta de busca com o pneu/modelo já informado e "bairro" para consultar uma loja que possa atender. Se AINDA NÃO houve cotação, faça a oferta com a opção elegível de cada pneu pedido antes de perguntar entrega/retirada; informe preço conforme PRICE DISCIPLINE. Se JÁ houve cotação, não repita a medida/preço sem necessidade: confirme a disponibilidade pela busca atual e avance na etapa que falta. Só reconheça uma loja com estoque quando o resultado confirmar; se não tiver, diga isso sem inventar disponibilidade.
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
