import type { FastifyReply, FastifyRequest } from 'fastify';
import { partnerPool } from './db.js';
import { env } from '../shared/config/env.js';

export type PartnerRole = 'owner' | 'funcionario';

export interface PartnerContext {
  environment: 'prod' | 'test';
  partnerId: string;
  partnerUnitId: string;
  unitId: string;
  slug: string;
  partnerName: string;
  unitName: string;
  role: PartnerRole;
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
  role: string;
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
/**
 * Valida slug+token e devolve o contexto do parceiro (ou null se invalido).
 * Reusavel fora do preHandler — ex.: SSE, onde o token vem por query string
 * porque EventSource nao manda header Authorization.
 */
export async function authenticatePartnerToken(
  slug: string,
  token: string,
): Promise<PartnerContext | null> {
  // A function e SECURITY DEFINER, entao roda com privilegios do owner e nao
  // depende da policy aplicada a role 'farejador_partner_app'.
  const result = await partnerPool.query<PartnerAuthRow>(
    'SELECT * FROM network.validate_partner_token($1, $2, $3)',
    [env.FAREJADOR_ENV, slug, token],
  );

  if (result.rowCount !== 1) return null;

  const row = result.rows[0]!;
  // Fail-safe: qualquer valor inesperado de role é tratado como 'funcionario'
  // (o menos privilegiado). Só 'owner' explícito libera tudo.
  const role: PartnerRole = row.role === 'owner' ? 'owner' : 'funcionario';
  return {
    environment: env.FAREJADOR_ENV,
    partnerId: row.partner_id,
    partnerUnitId: row.partner_unit_id,
    unitId: row.unit_id,
    slug: row.slug,
    partnerName: row.partner_name,
    unitName: row.unit_name,
    role,
  };
}

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

  const context = await authenticatePartnerToken(slug, token);
  if (!context) {
    void reply.status(401).send({ error: 'partner_unauthorized' });
    return;
  }

  request.partnerContext = context;
}

export function getPartnerContext(request: PartnerAuthedRequest): PartnerContext {
  if (!request.partnerContext) {
    throw new Error('partner_context_missing');
  }
  return request.partnerContext;
}

/**
 * Guarda de autorização: só DONO (role='owner') passa. Funcionário leva 403.
 *
 * Etapa 4 (níveis dono/funcionário). Usar SEMPRE depois de requirePartnerAuth,
 * encadeado: { preHandler: [requirePartnerAuth, requireOwner] }. A trava real
 * é aqui no servidor — esconder a aba no front sem barrar o endpoint seria
 * teatro (funcionário poderia chamar a API direto).
 */
export async function requireOwner(request: PartnerAuthedRequest, reply: FastifyReply): Promise<void> {
  const context = request.partnerContext;
  if (!context) {
    void reply.status(401).send({ error: 'partner_unauthorized' });
    return;
  }
  if (context.role !== 'owner') {
    void reply.status(403).send({ error: 'partner_forbidden_owner_only' });
    return;
  }
}
