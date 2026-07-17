/**
 * Leitor de comprovante da rota (0121, flag MATRIZ_RECEIPT_AI).
 *
 * O comprovante que o entregador anexa (cupom de posto, recibo de oficina)
 * passa pela visão da OpenAI, que devolve categoria + valor + estabelecimento
 * em JSON estrito. Este módulo só extrai uma sugestão; a revisão humana é a
 * única porta que pode transformar o documento em despesa financeira.
 *
 * Regras de dinheiro (inegociáveis):
 *   - NUNCA inventa valor: sem clareza → 'unreadable' (lançar na mão).
 *   - Confiança sinalizada abaixo de 0.7; valor tem que ser finito, > 0 e ≤ R$ 10.000
 *     (comprovante de rota acima disso é leitura errada, não gasto).
 *   - Erro de TRANSPORTE (rede/5xx/timeout) NÃO vira 'unreadable': estoura
 *     pra rota deixar o comprovante 'pending' com botão "ler de novo".
 *
 * 0130: o vocabulário de categoria deixou de ser fixo — a IA enxerga as
 * modalidades ATIVAS do dono (pedágio, alimentação…) e classifica nelas em vez
 * de jogar tudo em "outros". A busca é FAIL-OPEN: banco falhou → 6 de fábrica.
 *
 * Mesmo padrão do agent.ts: fetch cru no chat/completions, sem SDK.
 */

import { env } from '../../shared/config/env.js';
import { MATRIZ_EXPENSE_CATEGORIES, type MatrizExpenseCategory } from './queries-fiado-despesas.js';
import { listActiveExpenseCategorySlugs } from './queries-despesas-categorias.js';

export const RECEIPT_EXTRACTOR_VERSION = 'receipt-extractor-v2';
export const RECEIPT_PROMPT_VERSION = '2026-07-17-human-review-v1';

interface ReceiptReadingMetadata {
  model: string;
  extractor_version: string;
  prompt_version: string;
}

export type ReceiptReading = ReceiptReadingMetadata & (
  | { kind: 'parsed'; category: MatrizExpenseCategory; amount: number;
      merchant: string | null; document_date: string | null;
      confidence: number | null; summary: string }
  | { kind: 'unreadable'; summary: string }
);

export interface ReceiptCategoryOption {
  id: string;    // slug ('pedagio')
  label: string; // rótulo da tela ('Pedágio') — ajuda a IA a mapear o comprovante
}

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MIN_CONFIDENCE = 0.7;
const MAX_PLAUSIBLE_AMOUNT = 10_000;

const FALLBACK_CATEGORIES: ReceiptCategoryOption[] =
  MATRIZ_EXPENSE_CATEGORIES.map((id) => ({ id, label: id }));

/** Monta o prompt com o vocabulário VIVO de modalidades (puro — a prova testa sem rede). */
export function buildReceiptSystemPrompt(categories: ReceiptCategoryOption[]): string {
  const ids = categories.map((c) => c.id);
  const extras = categories.filter(
    (c) => !(MATRIZ_EXPENSE_CATEGORIES as readonly string[]).includes(c.id),
  );
  const extraLine = extras.length
    ? `- Modalidades do dono (use quando o comprovante for disso): ${extras.map((c) => `"${c.id}" = ${c.label}`).join('; ')}.`
    : null;
  return [
    'Você lê COMPROVANTES brasileiros (cupom fiscal, recibo de posto de gasolina, nota de oficina, comprovante de pagamento).',
    'Responda SÓ com um JSON, sem texto em volta:',
    `{"ok":true,"category":"${ids.join('|')}","amount":123.45,"merchant":"nome do estabelecimento","date":"YYYY-MM-DD ou null","confidence":0.0-1.0}`,
    'Regras:',
    '- amount = valor TOTAL pago, em reais, com PONTO decimal (ex.: 187.30). É o número que importa — confira duas vezes.',
    '- category: posto/combustível/gasolina/etanol/diesel/GNV → "combustivel"; oficina/peça/pneu/mecânica do VEÍCULO → "manutencao"; frete/carreto pago a terceiro → "frete".',
    ...(extraLine ? [extraLine] : []),
    '- Nada encaixou em nenhuma modalidade → "outros".',
    '- confidence: sua certeza de que o amount está certo.',
    '- Se a imagem não for um comprovante, ou o valor total não estiver legível, devolva {"ok":false,"reason":"explique em 1 frase o que faltou"}.',
    '- NUNCA invente ou estime valor. Ilegível = ok:false.',
  ].join('\n');
}

/** Categoria devolvida pela IA → slug VÁLIDO do vocabulário (fora dele = 'outros'). Pura. */
export function resolveReceiptCategory(raw: unknown, allowedIds: string[]): string {
  const c = String(raw);
  return allowedIds.includes(c) ? c : 'outros';
}

/** Modalidades ativas do env — FAIL-OPEN: banco falhou → as 6 de fábrica (a leitura nunca trava por isso). */
async function activeCategoriesFailOpen(): Promise<ReceiptCategoryOption[]> {
  try {
    const rows = await listActiveExpenseCategorySlugs();
    return rows.length ? rows : FALLBACK_CATEGORIES;
  } catch {
    return FALLBACK_CATEGORIES;
  }
}

/** Lê o comprovante. Joga erro em falha de transporte (fica 'pending', dá pra tentar de novo). */
export async function readReceiptWithAI(bytes: Buffer, mime: string): Promise<ReceiptReading> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('openai_key_missing');

  const categories = await activeCategoriesFailOpen();
  const body = JSON.stringify({
    model: env.OPENAI_MODEL,
    messages: [
      { role: 'system', content: buildReceiptSystemPrompt(categories) },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Leia este comprovante.' },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } },
        ],
      },
    ],
    max_completion_tokens: 300,
    response_format: { type: 'json_object' },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.OPENAI_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`openai_http_${response.status}`);

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('openai_empty_response');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return withMetadata({ kind: 'unreadable', summary: 'IA não devolveu leitura válida' });
  }

  if (parsed.ok !== true) {
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim() : 'não deu pra ler o valor com clareza';
    return withMetadata({ kind: 'unreadable', summary: reason });
  }

  const amount = Number(parsed.amount);
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_PLAUSIBLE_AMOUNT) {
    return withMetadata({ kind: 'unreadable',
      summary: `valor lido fora do esperado (${String(parsed.amount)})` });
  }

  const category = resolveReceiptCategory(parsed.category, categories.map((c) => c.id));
  const merchant = typeof parsed.merchant === 'string' && parsed.merchant.trim()
    ? parsed.merchant.trim() : null;
  const documentDate = typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
    ? parsed.date : null;
  const confidenceValue = Number.isFinite(confidence) ? confidence : null;
  const confidenceWarning = confidenceValue === null || confidenceValue < MIN_CONFIDENCE
    ? ' · baixa confiança — confira com atenção' : '';

  return withMetadata({
    kind: 'parsed',
    category,
    amount: Math.round(amount * 100) / 100,
    merchant,
    document_date: documentDate,
    confidence: confidenceValue,
    summary: `${merchant ?? 'estabelecimento'} · R$ ${amount.toFixed(2)}`
      + `${documentDate ? ` · ${documentDate}` : ''}${confidenceWarning} (sugestão da IA)`,
  });
}

function withMetadata<T extends { kind: 'parsed' | 'unreadable'; summary: string }>(
  reading: T,
): T & ReceiptReadingMetadata {
  return { ...reading, model: env.OPENAI_MODEL,
    extractor_version: RECEIPT_EXTRACTOR_VERSION,
    prompt_version: RECEIPT_PROMPT_VERSION };
}
