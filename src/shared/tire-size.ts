/**
 * Chave canonica de medida: os tres primeiros grupos numericos.
 * Vazio nunca casa, para que uma medida ausente falhe fechada.
 */
export function tireSizeKey(measure: string | null | undefined): string {
  const numbers = (measure ?? '').match(/\d+/g);
  if (!numbers || numbers.length === 0) return '';
  return numbers.slice(0, 3).join('-');
}
