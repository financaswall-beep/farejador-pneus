import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { Environment } from '../../../shared/types/chatwoot.js';

export function maskContactDetails(text: string) {
  return text.replace(/(?:https?:\/\/|www\.)\S+|\b(?:maps\.app\.goo\.gl|wa\.me)\/\S+/gi, '[link]')
    .replace(/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi, '[e-mail]')
    .replace(/\b(?:[a-z\d-]+\.)+[a-z]{2,}\b(?:[/?#]\S*)?/gi, '[link]')
    .replace(/[-+]?\d{1,3}[.,]\d{4,}\s*[,; ]\s*[-+]?\d{1,3}[.,]\d{4,}/g, '[localização]')
    .replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '[documento]')
    .replace(/(?:\+?55[ .-]*)?(?:\(\d{2}\)|\b\d{2})[ .-]*9?\d{4}[ .-]?\d{4}\b|\b9?\d{4}[- ]\d{4}\b/g, '[telefone]')
    .replace(/\b\d{5}-\d{3}\b/g, '[CEP]').replace(/\b\d{8,}\b/g, '[número pessoal]')
    .replace(/@[\w.-]+/g, '[perfil]');
}

export const privateRationale = z.string().trim().min(1).max(300).refine(
  text => !/[\r\n]/.test(text) && maskContactDetails(text) === text,
  'Descreva o motivo comercial sem dados pessoais, links ou transcrição.',
);

export const liveRationale = privateRationale.refine(
  text => !/[\u0000-\u001f\u007f"“”«»]|\b(?:rua|avenida|estrada|travessa|alameda|rodovia)\s|\bav\.\s|\b(?:me chamo|meu nome|chave pix)\b/i.test(text),
  'Informe somente o motivo comercial sem endereço, identificação ou fala do cliente.',
);

/** A comparação fica no banco; os nomes e as falas nunca entram na resposta MCP. */
export async function containsCustomerText(db: PoolClient, environment: Environment, conversation: string, trigger: string, reason: string) {
  const result = await db.query(`WITH alvo AS (
    SELECT ct.name, m.content,
      ' ' || btrim(regexp_replace(lower($4), '[^[:alnum:]]+', ' ', 'g')) || ' ' AS motivo
    FROM core.conversations c JOIN core.contacts ct ON ct.environment=c.environment AND ct.id=c.contact_id
    JOIN core.messages m ON m.environment=c.environment AND m.conversation_id=c.id AND m.id=$3
    WHERE c.environment=$1 AND c.id=$2
  ) SELECT FROM alvo CROSS JOIN LATERAL (VALUES (name,3),(content,14)) AS proibido(texto,minimo)
    CROSS JOIN LATERAL (SELECT btrim(regexp_replace(lower(texto), '[^[:alnum:]]+', ' ', 'g')) AS frase) AS trecho
    WHERE length(frase)>=minimo AND strpos(motivo,' '||frase||' ')>0 LIMIT 1`,
    [environment,conversation,trigger,reason]);
  return result.rowCount === 1;
}
