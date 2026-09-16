import type { PoolClient } from 'pg';
import { sendFinalAgentText, type SendFinalAgentTextInput } from './final-send.js';

export const HUMAN_HANDOFF_MESSAGE = 'Vou passar pro atendimento humano. O pessoal continua com você por aqui.';

export interface HumanHandoffContext {
  input: Omit<SendFinalAgentTextInput, 'body' | 'humanHandoff'>;
  toolCallId: string;
}

/** Encerra o turno sem outra chamada ao modelo. A outbox grava aviso + pausa
 * na mesma transação; em shadow, apenas a proposta fica registrada. */
export async function requestHumanHandoff(client: PoolClient, args: Record<string, unknown>,
  context: HumanHandoffContext): Promise<string> {
  if (!['cliente_pediu','duvida_complexa','reclamacao','tool_falhou','outro'].includes(String(args.motivo))
      || typeof args.resumo !== 'string' || !args.resumo.trim() || args.resumo.length > 500) {
    throw new Error('human_handoff_invalid_arguments');
  }
  const result = JSON.stringify({ ok:true, atendimento:'humano', bot_pausado:true });
  const status = await sendFinalAgentText(client, {
    ...context.input,
    body:HUMAN_HANDOFF_MESSAGE,
    humanHandoff:true,
    actions:[...context.input.actions,{ role:'tool',tool_call_id:context.toolCallId,content:result }],
  });
  return JSON.stringify({ ok:status==='sent', status, bot_pausado:status==='sent' });
}
