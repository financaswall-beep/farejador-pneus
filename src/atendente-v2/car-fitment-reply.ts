import type { ChatMessage } from './types.js';

/** Interpreta o aro ou a cabine no contexto da consulta do turno imediatamente anterior. */
export function carFitmentReplyNudge(history: ChatMessage[]): string {
  const last = history.at(-1);
  if (last?.role !== 'user') return '';
  const match = /^\s*(?:[ée]\s+)?(?:aro\s*|r\s*)?(\d{1,2})(?:\s*(?:polegadas|["”]))?[.! ]*$/iu.exec(last.content ?? '');
  const aro = Number(match?.[1]);
  const body = /^\s*(?:[ée]\s+)?(?:a\s+)?(cabine\s+(?:dupla|simples)|chassi)[.! ]*$/iu.exec(last.content ?? '')?.[1];
  if (!body && (!Number.isInteger(aro) || aro < 8 || aro > 30)) return '';
  const previousTurn: ChatMessage[] = [];
  for (let i = history.length - 2; i >= 0 && history[i]?.role !== 'user'; --i) {
    previousTurn.push(history[i]!);
  }
  for (const message of previousTurn) {
    const call = message.tool_calls?.find(call => call.function.name === 'buscar_compatibilidade');
    if (!call) continue;
    const reply = previousTurn.find(message => message.role === 'tool' && message.tool_call_id === call.id);
    if (!reply?.content) return '';
    try {
      const input = JSON.parse(call.function.arguments);
      const result = JSON.parse(reply.content);
      if (input?.tipo_veiculo !== 'car' || typeof input.modelo !== 'string' ||
        !(result?.precisa_confirmar_aro || result?.precisa_confirmar_medida || result?.precisa_confirmar_modelo_versao)) return '';
      const detail = body ? 'acrescente a carroceria informada (' + body + ') ao modelo anterior'
        : 'mantenha o modelo da consulta e passe aro=' + aro;
      return '\n\n[RESPOSTA À CONSULTA DO CARRO] Repita buscar_compatibilidade com o ano, posição e localização da última consulta; ' +
        detail + '. Use a medida ou a pergunta retornada. Um aro sozinho não é medida para buscar_produto.';
    } catch { return ''; }
  }
  return '';
}
