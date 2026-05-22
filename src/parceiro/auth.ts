import type { FastifyReply, FastifyRequest } from 'fastify';
import { partnerPool } from './db.js';
import { env } from '../shared/config/env.js';

export interface PartnerContext {
  environment: 'prod' | 'test';
  partnerId: string;
  partnerUnitId: string;
  unitId: string;
  slug: string;
  partnerName: string;
  unitName: string;
}

export interface PartnerAuthedRequest extends FastifyRequest {
  partnerContext?: PartnerContext;
}

interface PartnerAuthRow {
  partner_unit_id: string;
  unit_id: string;
  partner_id: string;
  slug: string;
  partner_name: string;
  unit_name: string;
  token_id: string;
}

function extractBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Valida token de parceiro via function SECURITY DEFINER no banco.
 *
 * V2 da Etapa 5 (pos-Codex): a comparacao de hash e feita inteiramente
 * no banco via network.validate_partner_token. A role 'farejador_partner_app'
 * NAO tem SELECT direto em partner_access_tokens — so EXECUTE na function.
 *
 * Isso fecha o buraco "qualquer endpoint que leia partner_access_tokens vaza
 * o mapa da rede inteira", porque a tabela nao e mais lida em SELECT pelo
 * portal — so pela function controlada.
 */
export async function requirePartnerAuth(request: PartnerAuthedRequest, reply: FastifyReply): Promise<void> {
  const params = request.params as { slug?: string };
  const slug = params.slug?.trim();
  const token = extractBearerToken(request.headers.authorization) ?? (
    typeof request.headers['x-partner-token'] === 'string' ? request.headers['x-partner-token'] : null
  );

  if (!slug || !token) {
    void reply.status(401).send({ error: 'partner_unauthorized' });
    return;
  }

  // Antes da validacao, GUC nao esta setado. A function e SECURITY DEFINER,
  // entao roda com privilegios do owner e nao depende da policy aplicada
  // a role 'farejador_partner_app'.
  const result = await partnerPool.query<PartnerAuthRow>(
    'SELECT * FROM network.validate_partner_token($1, $2, $3)',
    [env.FAREJADOR_ENV, slug, token],
  );

  if (result.rowCount !== 1) {
    void reply.status(401).send({ error: 'partner_unauthorized' });
    return;
  }

  const row = result.rows[0]!;

  request.partnerContext = {
    environment: env.FAREJADOR_ENV,
    partnerId: row.partner_id,
    partnerUnitId: row.partner_unit_id,
    unitId: row.unit_id,
    slug: row.slug,
    partnerName: row.partner_name,
    unitName: row.unit_name,
  };
}

export function getPartnerContext(request: PartnerAuthedRequest): PartnerContext {
  if (!request.partnerContext) {
    throw new Error('partner_context_missing');
  }
  return request.partnerContext;
}
