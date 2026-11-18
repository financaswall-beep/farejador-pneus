import { z } from 'zod';
import { env } from '../../../shared/config/env.js';
import { dotEventsAvailable } from './availability.js';

const conversationIds = z.array(z.string().uuid()).min(1).max(50);
let schemaReady = false;

export function shadowPilotIds(): string[] {
  const ids = env.DOT_NEGOTIATION_SHADOW_CONVERSATIONS.split(',').map(id => id.trim().toLowerCase());
  const result = conversationIds.safeParse(ids);
  return result.success ? [...new Set(result.data)] : [];
}

export function shadowPilotEnabled(): boolean {
  return env.DOT_EVENTS_ENABLED && shadowPilotIds().length > 0;
}

export function setShadowPilotSchemaReady(ready: boolean) {
  schemaReady = ready;
}

export function shadowPilotAvailable(conversationId?: string): boolean {
  if (!schemaReady || !dotEventsAvailable()) return false;
  const ids = shadowPilotIds();
  return conversationId === undefined ? ids.length > 0 : ids.includes(conversationId);
}

export const shadowPilotInstructions =
  ' Em evento de conversa com sombra_negociacao=true e objeção comercial, registre um único parecer privado para o turno V2 correspondente. '
  + 'Comece por consultar_contexto_negociacao_sombra com o eventId. A ferramenta identifica o turno exato e entrega as mensagens públicas até a pergunta do cliente. Use somente essa janela para avaliar o diálogo antes de registrar o parecer. '
  + 'Confira loja, medida, condição, quantidade, pagamento, custo, giro, reposição e custo adicional da parada na rota. Considere a política da loja parceira quando aplicável. '
  + 'Registre manter, aceitar, contrapropor ou aguardar_dado. Informe a modalidade e o total da compra em centavos ao propor preço. Quando faltar um dado decisivo, registre aguardar_dado e diga qual falta. '
  + 'Na justificativa resuma a conta e a incerteza sem copiar mensagens, nomes, endereços ou contatos. Use registrar_negociacao_sombra com o eventId e o turno exato. '
  + 'Se o turno ainda não estiver identificado ou não houver objeção, pule. Guarde o parecer em silêncio para revisão privada pelo dono. '
  + 'Quando o dono pedir a comparação, use consultar_negociacoes_sombra e consulte a mensagem pública referenciada para mostrar o que a atendente disse ao lado da decisão e do motivo da Milly.';
