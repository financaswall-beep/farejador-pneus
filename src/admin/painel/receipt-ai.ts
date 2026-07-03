/**
 * Leitor de comprovante da rota (0121, flag MATRIZ_RECEIPT_AI).
 *
 * O comprovante que o entregador anexa (cupom de posto, recibo de oficina)
 * passa pela visão da OpenAI, que devolve categoria + valor + estabelecimento
 * em JSON estrito. Quem LANÇA a despesa é recordReceiptAiResult (queries.ts),
 * na mesma transação que marca o comprovante — este módulo só LÊ.
 *
 * Regras de dinheiro (inegociáveis):
 *   - NUNCA inventa valor: sem clareza → 'unreadable' (lançar na mão).
 *   - Confiança mínima 0.7; valor tem que ser finito, > 0 e < R$ 10.000
 *     (comprovante de rota acima disso é leitura errada, não gasto).
 *   - Erro de TRANSPORTE (rede/5xx/timeout) NÃO vira 'unreadable': estoura
 *     pra rota deixar o comprovante 'pending' com botão "ler de novo".
 *
 * Mesmo padrão do agent.ts: fetch cru no chat/completions, sem SDK.
 */

import { env } from '../../shared/config/env.js';
import { MATRIZ_EXPENSE_CATEGORIES, type MatrizExpenseCategory } from './queries.js';

export type ReceiptReading =
  | { kind: 'parsed'; category: MatrizExpenseCategory; amount: number; summary: string }
  | { kind: 'unreadable'; summary: string };

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MIN_CONFIDENCE = 0.7;
const MAX_PLAUSIBLE_AMOUNT = 10_000;

const SYSTEM_PROMPT = [
  'Você lê COMPROVANTES brasileiros (cupom fiscal, recibo de posto de gasolina, nota de oficina, comprovante de pagamento).',
  'Responda SÓ com um JSON, sem texto em volta:',
  '{"ok":true,"category":"combustivel|manutencao|frete|outros","amount":123.45,"merchant":"nome do estabelecimento","date":"YYYY-MM-DD ou null","confidence":0.0-1.0}',
  'Regras:',
  '- amount = valor TOTAL pago, em reais, com PONTO decimal (ex.: 187.30). É o número que importa — confira duas vezes.',
  '- category: posto/combustível/gasolina/etanol/diesel/GNV → "combustivel"; oficina/peça/pneu/mecânica do VEÍCULO → "manutencao"; frete/carreto pago a terceiro → "frete"; qualquer outra coisa (pedágio, estacionamento, lanche) → "outros".',
  '- confidence: sua certeza de que o amount está certo.',
  '- Se a imagem não for um comprovante, ou o valor total não estiver legível, devolva {"ok":false,"reason":"explique em 1 frase o que faltou"}.',
  '- NUNCA invente ou estime valor. Ilegível = ok:false.',
].join('\n');

/** Lê o comprovante. Joga erro em falha de transporte (fica 'pending', dá pra tentar de novo). */
export async function readReceiptWithAI(bytes: Buffer, mime: string): Promise<ReceiptReading> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('openai_key_missing');

  const body = JSON.stringify({
    model: env.OPENAI_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
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
    return { kind: 'unreadable', summary: 'IA não devolveu leitura válida' };
  }

  if (parsed.ok !== true) {
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim() : 'não deu pra ler o valor com clareza';
    return { kind: 'unreadable', summary: reason };
  }

  const amount = Number(parsed.amount);
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(amount) || amount <= 0 || amount >= MAX_PLAUSIBLE_AMOUNT) {
    return { kind: 'unreadable', summary: `valor lido fora do esperado (${String(parsed.amount)})` };
  }
  if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) {
    return { kind: 'unreadable', summary: 'IA leu mas sem certeza suficiente — confere e lança na mão' };
  }

  const category: MatrizExpenseCategory = (MATRIZ_EXPENSE_CATEGORIES as readonly string[]).includes(String(parsed.category))
    ? (String(parsed.category) as MatrizExpenseCategory)
    : 'outros';
  const merchant = typeof parsed.merchant === 'string' && parsed.merchant.trim() ? parsed.merchant.trim() : 'estabelecimento';
  const date = typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? ` · ${parsed.date}` : '';

  return {
    kind: 'parsed',
    category,
    amount: Math.round(amount * 100) / 100,
    summary: `${merchant} · R$ ${amount.toFixed(2)}${date} (lido pela IA)`,
  };
}
