/**
 * PESQUISA DE SATISFAÇÃO (0105) — lógica PURA (sem banco/IO), testável em unit.
 * Separada de satisfaction.ts (que importa pool/sender) pelo mesmo motivo do
 * photo-nudge.ts: módulo de lógica pura não carrega env no import.
 */

/**
 * Extrai uma nota 1-5 de uma resposta CURTA do cliente. Conservador de propósito:
 * só casa mensagem que é basicamente a nota (número/estrelas) — qualquer texto mais
 * longo devolve null (a conversa segue pro bot normal, não vira nota errada).
 */
export function parseRating(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  // Estrelas: a mensagem é só ⭐/★ (1 a 5).
  const stars = (t.match(/[⭐★]/gu) || []).length;
  if (stars >= 1 && stars <= 5 && t.replace(/[⭐★\s]/gu, '') === '') return stars;
  // Número 1-5, opcionalmente "nota 5", "5 estrelas", "5/5", "5 de 5".
  const m = t.match(/^(?:nota\s*)?([1-5])(?:\s*(?:estrela|estrelas|⭐|★|\/\s*5|de\s*5))?\s*[!.]?$/u);
  return m ? Number(m[1]) : null;
}

// ─── Textos (rascunho — o dono ajusta; tudo dormente até ligar a flag) ───────

export function surveyQuestion(loja: string): string {
  return (
    `Opa! 😊 Como foi sua experiência com a *${loja}*? ` +
    `Responde de 1 a 5 (5 = nota máxima ⭐). Tua opinião ajuda demais!`
  );
}

export function thankYouText(rating: number): string {
  return rating >= 4
    ? 'Que massa! 🙏 Valeu pela nota ⭐ Qualquer coisa é só chamar.'
    : 'Valeu pela sinceridade 🙏 Vou repassar pra gente melhorar. Precisando, tô aqui!';
}
