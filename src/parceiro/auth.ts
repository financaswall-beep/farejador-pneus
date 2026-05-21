import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../persistence/db.js';
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
  token_id: string;
  token_hash: string;
  partner_id: string;
  partner_unit_id: string;
  unit_id: string;
  slug: string;
  partner_name: string;
  unit_name: string;
}

function extractBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeHashCompare(receivedHash: string, expectedHash: string): boolean {
  const received = Buffer.from(receivedHash, 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');

  if (received.length !== expected.length) {
    void timingSafeEqual(received, received);
    return false;
  }

  return timingSafeEqual(received, expected);
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

  const result = await pool.query<PartnerAuthRow>(
    `SELECT
       pat.id AS token_id,
       pat.token_hash,
       p.id AS partner_id,
       pu.id AS partner_unit_id,
       pu.unit_id,
       pu.slug,
       p.trade_name AS partner_name,
       pu.display_name AS unit_name
     FROM network.partner_units pu
     JOIN network.partners p
       ON p.id = pu.partner_id AND p.environment = pu.environment
     JOIN network.partner_access_tokens pat
       ON pat.partner_unit_id = pu.id AND pat.environment = pu.environment
     WHERE pu.environment = $1
       AND pu.slug = $2
       AND pu.status = 'active'
       AND p.status = 'active'
       AND pu.deleted_at IS NULL
       AND p.deleted_at IS NULL
       AND pat.revoked_at IS NULL
     LIMIT 10`,
    [env.FAREJADOR_ENV, slug],
  );

  const receivedHash = sha256(token);
  const row = result.rows.find((candidate) => safeHashCompare(receivedHash, candidate.token_hash));

  if (!row) {
    void reply.status(401).send({ error: 'partner_unauthorized' });
    return;
  }

  await pool.query('UPDATE network.partner_access_tokens SET last_used_at = now() WHERE id = $1', [row.token_id]);

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
