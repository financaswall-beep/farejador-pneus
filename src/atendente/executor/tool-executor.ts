import type { PoolClient } from 'pg';
import { deterministicUuid } from '../../shared/deterministic-id.js';
import { logger } from '../../shared/logger.js';
import {
  buscarCompatibilidade,
  buscarPoliticaComercial,
  buscarProduto,
  calcularFrete,
  verificarEstoque,
} from '../tools/commerce-tools.js';
import type { PlannerContext } from '../planner/context-builder.js';
import type { ToolRequest, ToolName } from '../planner/schemas.js';

export interface ToolExecutionResult {
  tool: ToolName;
  input: unknown;
  output: unknown;
  ok: boolean;
  duration_ms: number;
  error_message: string | null;
}

// Padrao de medida de pneu: ex. "110/70-17", "190/55R17", "90/90 18".
// Cobre os formatos mais comuns que o LLM Planner tem confundido com marca/product_code.
const TIRE_SIZE_PATTERN = /^\s*\d{2,3}\s*\/\s*\d{2,3}\s*[-\sR]?\s*\d{1,2}\s*$/i;

// Marcas de MOTO (nao de pneu) que o LLM tem enfiado erroneamente no campo marca de pneu.
// Lista nao-exaustiva: capturar os erros mais comuns. Marcas desconhecidas passam.
const MOTO_BRANDS = new Set([
  'honda', 'yamaha', 'suzuki', 'kawasaki', 'bmw', 'triumph', 'ducati',
  'ktm', 'harley', 'harley-davidson', 'royal enfield', 'bajaj', 'zontes',
  'voge', 'cfmoto', 'haojue', 'dafra', 'sundown', 'avelloz', 'mottu',
  'shineray', 'traxx', 'vento',
]);

function isTireSizeLike(value: string): boolean {
  return TIRE_SIZE_PATTERN.test(value);
}

function isMotoBrand(value: string): boolean {
  return MOTO_BRANDS.has(value.trim().toLowerCase());
}

/**
 * Higieniza inputs de buscarProduto antes de despachar.
 *
 * O LLM Planner tem alucinado os campos `marca` e `product_code` quando o
 * cliente da uma medida sem marca de fabricante: copia a medida ou a marca
 * da MOTO para esses campos, fazendo a busca retornar vazio (97% dos
 * buscar_e_ofertar pos-deploy entregavam tool_results=[] por causa disso).
 *
 * Estrategia: deny estrito em casos conhecidos (medida no marca/product_code,
 * marca de moto no campo marca). Inputs nao reconhecidos passam — sao
 * potenciais marcas de pneu novas e queremos ser permissivos.
 */
function sanitizeBuscarProdutoInput(input: unknown): { input: unknown; dropped: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { input, dropped: [] };
  }

  const record = { ...(input as Record<string, unknown>) };
  const dropped: string[] = [];
  const medida = typeof record.medida_pneu === 'string' ? record.medida_pneu.trim() : null;

  if (typeof record.marca === 'string') {
    const marca = record.marca.trim();
    if (marca === '' || isTireSizeLike(marca) || (medida && marca === medida) || isMotoBrand(marca)) {
      delete record.marca;
      dropped.push(`marca="${marca}"`);
    }
  }

  if (typeof record.product_code === 'string') {
    const code = record.product_code.trim();
    if (code === '' || isTireSizeLike(code) || (medida && code === medida)) {
      delete record.product_code;
      dropped.push(`product_code="${code}"`);
    }
  }

  return { input: record, dropped };
}

type BuscarProdutoRequest = Extract<ToolRequest, { tool: 'buscarProduto' }>;

// ------------------------------------------------------------------
// Auto-chain de verificarEstoque pos-buscarProduto.
//
// Regra deterministica: sempre que buscarProduto retornar produto concreto
// (product_id) e verificarEstoque ainda NAO tiver rodado neste turn,
// disparamos verificarEstoque(product_id=primeiro) automaticamente.
//
// Sem regex sobre a mensagem do cliente. Sem "adivinhar intencao". Achou
// produto -> confirma estoque. Custo: 1 query extra por turn comercial.
// Ganho: Generator recebe evidencia de estoque sempre que ha produto, sem
// depender do LLM Planner perceber intencao.
//
// Etapa futura (structured claims): substituir o resto dos validators
// regex por claims tipados emitidos pelo Generator (ver plan file).
// ------------------------------------------------------------------

function pickFirstProductIdFromResults(results: ToolExecutionResult[]): string | null {
  for (const result of results) {
    if (result.tool !== 'buscarProduto' || !result.ok || !Array.isArray(result.output)) continue;
    for (const product of result.output) {
      if (product && typeof product === 'object') {
        const id = (product as Record<string, unknown>).product_id;
        if (typeof id === 'string' && id.length > 0) return id;
      }
    }
  }
  return null;
}

function verificarEstoqueAlreadyRan(results: ToolExecutionResult[]): boolean {
  return results.some((result) => result.tool === 'verificarEstoque');
}

/**
 * Se buscarProduto retornou produto e verificarEstoque ainda nao rodou,
 * dispara verificarEstoque(product_id=primeiro) automaticamente.
 * Retorna null quando nao ha o que fazer (noop seguro).
 *
 * Sem heuristica sobre a mensagem do cliente — regra puramente deterministica.
 */
export async function maybeAutoChainVerificarEstoque(
  client: PoolClient,
  environment: 'prod' | 'test',
  toolResults: ToolExecutionResult[],
): Promise<ToolExecutionResult | null> {
  if (verificarEstoqueAlreadyRan(toolResults)) return null;

  const productId = pickFirstProductIdFromResults(toolResults);
  if (!productId) return null;

  const autoRequest: ToolRequest = {
    tool: 'verificarEstoque',
    input: { environment, product_id: productId } as Extract<ToolRequest, { tool: 'verificarEstoque' }>['input'],
  };

  logger.info(
    { product_id: productId, environment },
    'tool-executor: auto-chain verificarEstoque disparado pos-buscarProduto',
  );

  return executeToolRequest(client, autoRequest);
}

function sanitizeToolInput(request: ToolRequest): { request: ToolRequest; dropped: string[] } {
  if (request.tool !== 'buscarProduto') {
    return { request, dropped: [] };
  }
  const sanitized = sanitizeBuscarProdutoInput(request.input);
  if (sanitized.dropped.length === 0) {
    return { request, dropped: [] };
  }
  const cleanInput = sanitized.input as BuscarProdutoRequest['input'];
  const cleanRequest: BuscarProdutoRequest = { tool: 'buscarProduto', input: cleanInput };
  return { request: cleanRequest, dropped: sanitized.dropped };
}

export async function executeToolRequests(
  client: PoolClient,
  requests: ToolRequest[],
): Promise<ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = [];
  for (const request of requests) {
    results.push(await executeToolRequest(client, request));
  }
  return results;
}

export async function executeToolRequest(
  client: PoolClient,
  request: ToolRequest,
): Promise<ToolExecutionResult> {
  const startedAt = Date.now();
  const { request: cleanRequest, dropped } = sanitizeToolInput(request);
  if (dropped.length > 0) {
    logger.warn(
      { tool: request.tool, dropped, original_input: request.input },
      'tool-executor: campos suspeitos removidos do input antes do dispatch',
    );
  }
  try {
    const output = await dispatchTool(client, cleanRequest);
    return {
      tool: cleanRequest.tool,
      input: cleanRequest.input,
      output,
      ok: true,
      duration_ms: Date.now() - startedAt,
      error_message: null,
    };
  } catch (error) {
    return {
      tool: cleanRequest.tool,
      input: cleanRequest.input,
      output: null,
      ok: false,
      duration_ms: Date.now() - startedAt,
      error_message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function recordToolExecutionResults(
  client: PoolClient,
  context: PlannerContext,
  results: ToolExecutionResult[],
): Promise<void> {
  for (const [index, result] of results.entries()) {
    await client.query(
      `INSERT INTO agent.session_events
         (environment, conversation_id, turn_index, event_type, event_payload, emitted_by, action_id)
       VALUES ($1, $2, $3, $4, $5, 'system', $6)
       ON CONFLICT (action_id) DO NOTHING`,
      [
        context.environment,
        context.conversation_id,
        context.state.turn_index + 1,
        result.ok ? 'tool_executed' : 'tool_failed',
        JSON.stringify({
          tool: result.tool,
          input: result.input,
          output: result.output,
          ok: result.ok,
          duration_ms: result.duration_ms,
          error_message: result.error_message,
        }),
        deterministicUuid([
          'tool_execution',
          context.environment,
          context.conversation_id,
          context.state.turn_index + 1,
          index,
          result.tool,
          result.input,
          result.ok,
        ]),
      ],
    );
  }
}

async function dispatchTool(client: PoolClient, request: ToolRequest): Promise<unknown> {
  switch (request.tool) {
    case 'buscarProduto':
      return buscarProduto(client, request.input);
    case 'verificarEstoque':
      return verificarEstoque(client, request.input);
    case 'buscarCompatibilidade':
      return buscarCompatibilidade(client, request.input);
    case 'calcularFrete':
      return calcularFrete(client, request.input);
    case 'buscarPoliticaComercial':
      return buscarPoliticaComercial(client, request.input);
  }
}
