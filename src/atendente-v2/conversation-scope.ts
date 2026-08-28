/**
 * Escopo explícito do canário do Agent V2.
 *
 * A lista usa o UUID interno de core.conversations. Vazio fecha tudo; "*" abre
 * tudo somente quando o operador o declarar conscientemente no ambiente.
 */
export function isAgentV2ConversationAllowed(
  allowedConversationIds: readonly string[],
  conversationId: string,
): boolean {
  if (allowedConversationIds.length === 0) return false;
  return allowedConversationIds.includes('*') || allowedConversationIds.includes(conversationId);
}

export function hasAgentV2Wildcard(allowedConversationIds: readonly string[]): boolean {
  return allowedConversationIds.includes('*');
}
