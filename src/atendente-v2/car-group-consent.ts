import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';

interface OfferReply { cliente: boolean; texto: string }

function cleanReply(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

export function acceptedCarGroup(sayText: string, quantity: number, replies: OfferReply[]): boolean {
  const names = ['zero', 'um', 'dois', 'tres', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez'];
  const count = new RegExp(`\\b(?:${quantity}${names[quantity] ? '|' + names[quantity] : ''}${quantity === 2 ? '|duas' : ''})\\s+(?:pneus?|unidades?)\\b`);
  const pair = /\b(?:par|parzinho)\b/;
  const set = /\b(?:conjunto|jogo|par|parzinho)\b/;
  const action = /\b(?:(?:quer|vai|posso|vamos|pode)\s+(?:levar|ficar|fechar|reservar|confirmar|aproveitar|comprar)|quer\s+(?:o|um)\s+(?:conjunto|jogo|par|parzinho))\b/;
  const explicit = /\b(?:quero|vou (?:levar|querer)|leva|fico|manda|fecha|reserva|aceito|confirmo|pode ser|pode fechar|pode reservar|pode mandar)\b/;
  // O objeto da decisão deve ser o pneu. "Quero ver a foto do par" não autoriza uma reserva.
  const purchase = new RegExp(`${explicit.source}\\s+(?:(?:levar|fechar|reservar|comprar|ficar)\\s+)?(?:com\\s+)?(?:(?:o|os|um|esse|esses|este|estes|aquele|aqueles)\\s+)?(?:${set.source}|${count.source})`);
  const isSet = (text: string) => set.test(text) || count.test(text);
  const invites = (text: string) => {
    const lastQuestion = text.match(/[^.!?]+\?\s*$/)?.[0] ?? '';
    return isSet(lastQuestion) && action.test(lastQuestion)
      && !/\b(?:ou|foto|ver|desconto|estado)\b/.test(lastQuestion);
  };
  if (!isSet(cleanReply(sayText))) return false;
  let allowed = invites(cleanReply(sayText));
  let accepted = false;
  for (const reply of replies) {
    const text = cleanReply(reply.texto);
    if (!reply.cliente) {
      allowed = invites(text);
      continue;
    }
    const quantities = Array.from(text.matchAll(/\b(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\s+(?:pneus?|unidades?)\b/g));
    const changedQuantity = explicit.test(text) && (quantities.some(match => !count.test(match[0]))
      || (quantity !== 2 && pair.test(text)));
    const negated = /\b(?:nao|nem|nunca|jamais|negativo)\b/.test(text);
    const refused = negated && (explicit.test(text) || isSet(text)
      || /^(?:nao|negativo|prefiro nao|agora nao|melhor nao|nem pensar)(?:[,\s]+(?:obrigad[oa]|valeu))?[.!\s]*$/.test(text));
    const undecided = /\b(?:talvez|vou pensar|acho que|ainda (?:estou pensando|nao decidi)|deixa (?:eu pensar|pra depois|pra la)|na duvida|dependendo|mudei de ideia)\b/.test(text);
    const conditional = /\b(?:se|caso|ou|mas|porem|desconto|caro)\b|r\$/.test(text);
    if (changedQuantity || refused || undecided || (conditional && purchase.test(text))
      || /\b(?:desisti|cancela\w*|so (?:um|uma|[1-9]|dois|tres|quatro)|avuls[oa]s?|troca\w*|outro(?:s)? pneu)\b/.test(text)) {
      accepted = false;
    } else if (!negated && !text.includes('?') && !conditional && (purchase.test(text)
      || allowed && /^(?:sim|aceito|confirmo|fechado|fechou|pode ser|pode fechar|pode reservar)[.!\s👍✅]*$/u.test(text))) {
      accepted = true;
    }
    allowed = false;
  }
  return accepted;
}

export async function customerAcceptedCarGroup(
  client: PoolClient, environment: Environment, conversationId: string, requestId: string | null,
  previous: { say_text: string; provider_message_id: string | null }, quantity: number,
): Promise<boolean> {
  if (!requestId || !previous.provider_message_id) return false;
  const replies = await client.query<OfferReply>(`
    SELECT m.sender_type='contact' AS cliente,COALESCE(m.content,'') AS texto
      FROM core.messages m
      JOIN core.messages current ON current.environment=m.environment
        AND current.conversation_id=m.conversation_id AND current.id=$3
      WHERE m.environment=$1 AND m.conversation_id=$2 AND NOT m.is_private AND m.deleted_at IS NULL
        AND ((m.sender_type='contact' AND m.message_type=0) OR (m.sender_type IN ('user','agent_bot') AND m.message_type=1))
        AND m.chatwoot_message_id>$4::bigint AND m.chatwoot_message_id<=current.chatwoot_message_id
      ORDER BY m.chatwoot_message_id DESC LIMIT 25`,
  [environment, conversationId, requestId, previous.provider_message_id]);
  return replies.rows.length <= 24 && acceptedCarGroup(previous.say_text, quantity, replies.rows.reverse());
}
