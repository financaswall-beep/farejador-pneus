import { createHash } from 'node:crypto';
import type { Platform } from './config.js';

// Contato público aprovado pelo dono; nunca extraído do comentário do cliente.
export const COMMENTS_WHATSAPP = '(21) 97250-9411';

export function publicReply(body: string, platform: Platform, seed: string): string {
  const answer = body.trim().replace(/\bmatriz\b/gi, 'loja');
  // O modelo só escreve a resposta. Contatos e encaminhamento vêm desta configuração.
  if (!answer || answer.length > 700 || /https?:\/\/|www\.|@[\w.]|(?:\+55\s*)?\(?\b\d{2}\)?[\s-]*\d{4,5}[\s-]*\d{4}\b/i.test(answer)) {
    throw new Error('comment_public_reply_invalid');
  }
  const channel = platform === 'instagram' ? 'Direct' : 'Messenger';
  const endings = [
    `Chama no WhatsApp ${COMMENTS_WHATSAPP} ou aqui no ${channel} que seguimos por lá!`,
    `Fala com a gente no WhatsApp ${COMMENTS_WHATSAPP} ou pelo ${channel}!`,
    `Pode chamar no ${channel} ou no WhatsApp ${COMMENTS_WHATSAPP} pra gente continuar.`,
  ];
  const index = createHash('sha256').update(seed).digest()[0]! % endings.length;
  return `${answer}\n\n${endings[index]}`;
}
