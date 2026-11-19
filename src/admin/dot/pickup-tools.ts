import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  cancelMatrizPickupInTransaction, readMatrizPickupCancellationCandidate,
} from '../painel/queries-pickup-cancel.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, operationFingerprint,
} from '../painel/stage5-integrity.js';
import { DOT_SCOPE } from './config.js';
import { lockGrant, transact } from './installment-reviews.js';
import { markOperationExecuted, requireOperationReview } from './operation-reviews.js';
import type { DotIdentity } from './token-store.js';

const lookupTool = 'consultar_retirada_para_cancelar';
export const cancelPickupTool = 'cancelar_retirada_matriz';

const lookupSchema = z.object({
  retirada_id: z.string().uuid().optional(),
  numero_pedido: z.string().trim().max(24).regex(/^(?:PED-)?[0-9]+$/i)
    .describe('Número interno, por exemplo PED-0060 ou 60.').optional(),
}).strict().refine(data => Boolean(data.retirada_id) !== Boolean(data.numero_pedido));
const cancelSchema = z.object({
  retirada_id: z.string().uuid(),
  revisao: z.string().regex(/^[a-f0-9]{64}$/).describe('Valor retornado pela consulta de cancelamento do mesmo pedido.'),
  motivo: z.string().trim().min(1).max(500),
  idempotency_key: z.string().uuid().describe('Use a mesma chave ao repetir a proposta autorizada.'),
}).strict();

function describeTool(name: string, description: string, schema: z.ZodTypeAny, readOnly: boolean):
Tool & { securitySchemes: Array<{ type: string; scopes: string[] }> } {
  const { $schema, ...inputSchema } = zodToJsonSchema(schema, { $refStrategy: 'none' });
  const securitySchemes = [{ type: 'oauth2', scopes: [DOT_SCOPE] }];
  return { name, description, inputSchema: inputSchema as Tool['inputSchema'], securitySchemes,
    _meta: { securitySchemes },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: false } };
}

export const pickupTools = [
  describeTool(lookupTool,
    'Identifica uma retirada em aberto com reserva de estoque da Matriz, pelo número interno do pedido ou UUID. Mostra cliente, itens, total e o campo revisao usado para preparar o cancelamento.',
    lookupSchema, true),
  describeTool(cancelPickupTool,
    'Prepara e executa o cancelamento de uma retirada reservada da Matriz, liberando o estoque conforme as regras da loja. Consulte a retirada primeiro e informe o motivo. Apresente o número, cliente, itens e valor do pedido e peça confirmação específica ao dono. Em conversa use confirmar_operacao_milly após resposta direta por voz ou texto e repita os mesmos argumentos; em painel apresente confirm_url. Só anuncie cancelamento quando executada=true.',
    cancelSchema, false),
];

async function requestCancellation(identity: DotIdentity, raw: unknown) {
  const request = cancelSchema.parse(raw);
  const { idempotency_key, retirada_id, revisao, motivo } = request;
  const environment = env.FAREJADOR_ENV;
  return transact(async db => {
    const grant = await lockGrant(db, identity.person_id, identity.grant_id);
    const pending = await requireOperationReview(db, identity, cancelPickupTool, idempotency_key, async () => {
      const candidate = await readMatrizPickupCancellationCandidate(db, environment, { order_id: retirada_id }, true);
      if (candidate.revisao !== revisao) throw new Error('retirada_alterada_consulte_novamente');
      return { ...request, ficha: candidate.ficha };
    }, grant, 'pickup');
    if (pending) return pending;

    const operation = { environment, domain: 'dot.' + cancelPickupTool, idempotencyKey: idempotency_key,
      fingerprint: operationFingerprint({ grant: identity.grant_id, retirada_id, revisao, motivo }) };
    const previous = await beginIntegrityOperation<Record<string, unknown>>(db, operation);
    if (previous.replayed) return previous.result;
    const cancellation = await cancelMatrizPickupInTransaction(db, {
      environment, order_id: retirada_id, expected_revision: revisao, reason: motivo, actor_label: 'Milly · ' + identity.person_id,
    });
    const result = { status: 'executada', executada: true, resultado: { retirada_id, ...cancellation } };
    await completeIntegrityOperation(db, operation, 'commerce.orders', retirada_id, result);
    await markOperationExecuted(db, identity, cancelPickupTool, idempotency_key);
    return result;
  });
}

export async function invokePickupTool(identity: DotIdentity, name: string, args: unknown) {
  try {
    let result;
    if (name === lookupTool) {
      const input = lookupSchema.parse(args);
      const lookup = input.retirada_id ? { order_id: input.retirada_id }
        : { order_number: 'PED-' + input.numero_pedido!.replace(/^PED-/i, '').padStart(4, '0') };
      result = await readMatrizPickupCancellationCandidate(pool, env.FAREJADOR_ENV, lookup);
    } else {
      result = await requestCancellation(identity, args);
    }
    return { structuredContent: result, content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (error) {
    if (error instanceof z.ZodError) throw new McpError(ErrorCode.InvalidParams, 'Confira a identificação, a revisão e o motivo da retirada.');
    const code = error instanceof Error && /^[a-z][a-z0-9_]{2,100}$/.test(error.message)
      ? error.message : 'retirada_indisponivel';
    return { isError: true as const, content: [{ type: 'text' as const, text: code }] };
  }
}
