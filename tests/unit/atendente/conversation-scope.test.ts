import { describe, expect, it } from 'vitest';
import {
  hasAgentV2Wildcard,
  isAgentV2ConversationAllowed,
} from '../../../src/atendente-v2/conversation-scope.js';

describe('Agent V2 conversation scope', () => {
  it('fecha tudo quando a lista está vazia', () => {
    expect(isAgentV2ConversationAllowed([], 'conversation-a')).toBe(false);
  });

  it('permite somente a conversa explicitamente configurada', () => {
    expect(isAgentV2ConversationAllowed(['conversation-a'], 'conversation-a')).toBe(true);
    expect(isAgentV2ConversationAllowed(['conversation-a'], 'conversation-b')).toBe(false);
  });

  it('aceita múltiplas conversas e rejeita as demais', () => {
    const allowed = ['conversation-a', 'conversation-b'];
    expect(isAgentV2ConversationAllowed(allowed, 'conversation-b')).toBe(true);
    expect(isAgentV2ConversationAllowed(allowed, 'conversation-c')).toBe(false);
  });

  it('abre todas somente com o curinga explícito', () => {
    expect(isAgentV2ConversationAllowed(['*'], 'qualquer-conversa')).toBe(true);
    expect(hasAgentV2Wildcard(['*'])).toBe(true);
    expect(hasAgentV2Wildcard(['conversation-a'])).toBe(false);
  });
});
