export const CUSTOMER_LOCATION_REQUEST =
  'Me manda sua localização fixa 📍 ou seu endereço, amigo, que eu vejo onde encontro esse pneu mais perto de você.';

// Aceita a escrita de balcão ("130 70 13"), sem confundir datas/telefones usuais.
const TIRE_SIZE_RE = /\b(?:(?:[6-9]\d|[1-3]\d{2})(?:\s*[/\-]\s*|\s+)(?:[2-9]\d|100)(?:\s*(?:ZR|R|B|[-/])\s*|\s+)(?:1\d|2\d)|\d{1,2}\.\d{2}\s*[-/]\s*\d{2})\b/i;
const TIRE_REQUEST_RE = /\bpneu(?:s|zinho|zinhos)?\b|\b(?:dianteiro|traseiro)\b/i;

/** Alinha a instrução de busca à etapa de localização. O histórico continua
 * sendo usado para aceitar endereço/bairro digitados, além do pino nativo. */
export function buildProductSearchNudge(latestCustomerText: string | null | undefined, hasPin: boolean): string {
  if (!latestCustomerText || (!TIRE_SIZE_RE.test(latestCustomerText) && !TIRE_REQUEST_RE.test(latestCustomerText))) return '';
  const search = TIRE_SIZE_RE.test(latestCustomerText)
    ? 'O cliente informou uma medida: use buscar_produto com essa medida. Escrita com espaços, como 130 70 13, significa 130/70-13. Preserve R/ZR/B quando informados. Para buscar e cotar, não pergunte modelo da moto, ano, dianteiro/traseiro nem peça foto ou confirmação da medida já completa. Não use buscar_compatibilidade apenas para repetir essa identificação. Só investigue aplicação se o cliente perguntar se serve na moto ou houver um conflito concreto.'
    : 'Use buscar_produto se houver medida ou marca; use buscar_compatibilidade quando houver somente o modelo da moto.';
  return `\n\n[LOCALIZAÇÃO ANTES DA DISPONIBILIDADE DO PNEU]
Este lembrete vale para busca/cotação de pneu. Se o assunto for pedido existente, cancelamento, entrega em andamento ou política da loja, siga o fluxo correspondente; mencionar pneu não exige uma nova busca.
${hasPin
    ? 'O cliente JÁ enviou o pino de localização. Use-o e consulte as ferramentas sem bairro. NÃO peça a localização novamente.'
    : `Confira a mensagem atual e o histórico: se o cliente ainda NÃO informou localização, endereço ou região, peça somente a localização fixa ou o endereço e AGUARDE. Use: "${CUSTOMER_LOCATION_REQUEST}". Não comece com "tenho sim", "temos" ou outra confirmação; não antecipe preço, modelo/ano ou busca de estoque nessa etapa. Se o endereço/bairro/região JÁ foi informado, aproveite-o, registre a localização conforme a regra existente e siga para a consulta, sem pedir novamente.`}
Depois da localização: ${search}
Só confirme disponibilidade com resultado DESTE TURNO para uma loja que possa atender. Aplicação/medida ou estoque_consultado=false não confirma estoque. Não invente bairro nem use disponibilidade de outra região.`;
}
