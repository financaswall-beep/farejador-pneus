const EXACT_PLACEHOLDERS = new Set([
  'cliente', 'lead', 'unknown', 'desconhecido', 'visitante', 'no name', 'sem nome',
  'whatsapp', 'user', 'john doe', 'jhon doe', 'jane doe',
]);

export function isPlaceholderCustomerName(value: string | null | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (trimmed.length < 2) return true;
  if (/^\+?\d[\d\s\-()]*$/.test(trimmed)) return true;
  const normalized = trimmed.toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ');
  if (EXACT_PLACEHOLDERS.has(normalized)) return true;
  // O Chatwoot pode gerar nomes como "lively-bush-319" quando não recebe o nome do perfil.
  if (/^[a-z]+-[a-z]+-\d{2,}$/i.test(trimmed)) return true;
  return [...EXACT_PLACEHOLDERS].some((placeholder) => normalized.startsWith(`${placeholder} `));
}

export function safeCustomerDisplayName(value: string | null | undefined): {
  name: string;
  needs_review: boolean;
} {
  if (isPlaceholderCustomerName(value)) return { name: 'Cliente sem nome', needs_review: true };
  return { name: String(value).trim(), needs_review: false };
}

export function normalizeCustomerNameForOrder(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().slice(0, 200);
  return isPlaceholderCustomerName(name) ? null : name;
}
