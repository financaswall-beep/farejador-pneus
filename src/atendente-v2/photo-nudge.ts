/**
 * EMPURRÃO DETERMINÍSTICO DA FOTO — gêmeo do nudge do pino (ver agent.ts).
 *
 * Sintoma real (validado ao vivo 2026-06-10): mesmo com o PHOTO_PROMPT_BLOCK
 * ligado, o bot CONFABULA quando o cliente pede foto — responde "já pedi pro
 * pessoal separar a foto" / "vou chamar a loja" SEM chamar a tool pedir_foto.
 * Resultado: nenhum photo_request nasce, nenhuma loja é avisada, o cliente
 * espera à toa. É o mesmo problema do pino: prompt geral não garante.
 *
 * Conserto (garantido por CÓDIGO, não por prompt): detectamos por regra quando
 * o cliente está pedindo pra VER o pneu e injetamos uma ordem forte, focada no
 * turno, que PROÍBE a promessa-sem-chamada e manda chamar a tool AGORA. A tool
 * tem os próprios guards (precisa_produto / sem_loja / dedup / limite_fotos),
 * então um disparo a mais é inofensivo — por isso pesa pra RECALL (na dúvida,
 * empurra), só barrando negações explícitas.
 */

function normalize(text: string): string {
  // NFD + remove diacríticos (\p{Diacritic}) → "não" vira "nao", "você" "voce".
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

// Pedido direto de foto/imagem ("imagem" singular termina em M, "imagens" em NS).
const PHOTO_WORDS = /\bfotos?\b|\bimage(m|ns)\b/;
// "ver/olhar/mostrar o pneu/ele/esse" — pedir pra ver sem dizer "foto".
const SEE_TIRE = /\b(ver|olhar|mostra|mostrar|conhecer)\b[^.!?]{0,24}\b(pneu|ele|esse|isso|produto)\b/;
// Negação explícita NÃO dispara (contígua, pra não pegar "não quero a X, quero ver a foto").
const NEGATION =
  /\bnao\s+(quero|preciso|precisa|vou querer)\s+(de\s+|uma\s+|a\s+|ver\s+)*(foto|imagem)\b|\bsem\s+(foto|imagem)\b/;
// Cobrança/confirmação de envio logo após o bot ter FALADO de foto (recuperação
// do turno seguinte: "pode mandar", "tô esperando", "manda aí", "pode pedir").
const SEND_FOLLOWUP =
  /\b(manda|mandar|envia|enviar|esperando|aguardando)\b|pode\s+(mandar|pedir|enviar)|quero\s+(ver|sim)/;

/**
 * O cliente está pedindo pra ver o pneu (foto)? Considera a última fala do
 * cliente e, como rede de segurança, a cobrança no turno seguinte quando o bot
 * acabou de mencionar foto (caso o empurrão do turno anterior tenha falhado).
 */
export function customerWantsPhoto(
  latestUserText: string | null | undefined,
  lastAssistantText?: string | null | undefined,
): boolean {
  if (!latestUserText) return false;
  const u = normalize(latestUserText);
  if (!u.trim()) return false;
  if (NEGATION.test(u)) return false;
  if (PHOTO_WORDS.test(u) || SEE_TIRE.test(u)) return true;
  // Follow-up só conta se o BOT acabou de falar de foto (senão "manda" é genérico).
  if (lastAssistantText) {
    const a = normalize(lastAssistantText);
    if (PHOTO_WORDS.test(a) && SEND_FOLLOWUP.test(u)) return true;
  }
  return false;
}

/**
 * Ordem injetada no fim do system prompt SÓ no turno em que o cliente pede foto
 * (e só com PHOTO_REQUESTS on). Alta autoridade + recência (igual ao pinNudge),
 * e proíbe NOMINALMENTE as frases que o bot usou pra enrolar.
 */
export const PHOTO_NUDGE = `\n\n[CLIENTE PEDIU FOTO 📸] O cliente acabou de pedir pra VER o pneu. A ÚNICA forma de a loja ser avisada e a foto chegar até ele é você CHAMAR a ferramenta pedir_foto AGORA, neste mesmo turno. É TERMINANTEMENTE PROIBIDO dizer "vou pedir pro pessoal", "já pedi", "vou chamar a loja" ou "assim que mandarem te envio" SEM ter chamado a ferramenta — sem a chamada NADA acontece, nenhuma loja é avisada, e o cliente espera à toa (isso é mentira). Então CHAME pedir_foto já. Se ela retornar precisa_produto ou sem_loja, SÓ AÍ pergunte o que falta. Fale da foto pro cliente SOMENTE depois de ter chamado a ferramenta.`;
