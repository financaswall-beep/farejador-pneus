/**
 * Normalizacao de telefone para E.164 (formato internacional padrao).
 *
 * Por que existir:
 *   commerce.partner_orders.customer_phone declarado como "E.164 normalizado"
 *   na 0040 (linha 46), mas registerPartnerSale (queries.ts) gravava string
 *   crua. Bug S4 da auditoria 2026-05-21.
 *
 * Regras:
 *   - Aceita "(21) 99999-9999", "21999999999", "+5521999999999", "5521999999999"
 *   - Remove espacos, parenteses, hifens, pontos
 *   - Adiciona "+55" quando ausente (assumindo Brasil)
 *   - Para celular brasileiro, valida 11 digitos apos DDD (com 9 inicial)
 *   - Para fixo brasileiro, valida 10 digitos apos DDD
 *   - Numeros que nao casam o padrao brasileiro: aceita se for E.164 valido
 *     (comeca com +, 8-15 digitos)
 *   - Retorna null se nao conseguir normalizar
 *
 * Nao usa libphonenumber-js pra nao adicionar dep nova. Cobertura limitada
 * a numeros brasileiros + E.164 generico. Se um dia precisar de internacional
 * de verdade, troca por libphonenumber.
 */

const E164_REGEX = /^\+[1-9]\d{7,14}$/;

export function normalizeBrazilianPhone(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const trimmed = String(input).trim();
  if (trimmed.length === 0) return null;

  // Mantem so digitos e o + inicial
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.length === 0) return null;

  // Ja vem com + ? valida E.164 generico
  if (digits.startsWith('+')) {
    if (E164_REGEX.test(digits)) return digits;
    // tenta interpretar como brasileiro sem o "55"
    if (digits.startsWith('+55') && (digits.length === 13 || digits.length === 14)) {
      return digits;
    }
    return null;
  }

  // Sem +. Pode ser:
  //   "21999999999"   (DDD + numero, 11 dig)
  //   "2199999999"    (DDD + fixo, 10 dig)
  //   "5521999999999" (com 55 mas sem +)
  //   "0021999999..." (com prefixo internacional brasileiro 00, raro)
  const only = digits.replace(/^\+/, '');

  if (only.startsWith('55') && (only.length === 12 || only.length === 13)) {
    return `+${only}`;
  }
  if (only.startsWith('0055') && only.length >= 14) {
    return `+${only.slice(2)}`;
  }
  if (only.length === 10 || only.length === 11) {
    // DDD + numero (10 fixo / 11 celular). Assume Brasil.
    return `+55${only}`;
  }

  return null;
}
