import { createHash, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { DOT_ACCESS_SECONDS, DOT_SCOPE, type DotConfig } from './config.js';
import { dotHash, dotSecret } from './consent-store.js';
import type { dotTokenBody } from './oauth-validation.js';

export interface DotIdentity { grant_id: string; person_id: string; collaborator_id: string }
const activeOwner = `JOIN network.matriz_collaborators mc ON mc.id=g.collaborator_id
  AND mc.environment=g.environment AND mc.person_id=g.person_id AND mc.panel_role='owner' AND mc.revoked_at IS NULL
  JOIN network.partner_people p ON p.id=g.person_id AND p.environment=g.environment AND p.revoked_at IS NULL`;
const activeGrant = `g.environment=$1 AND g.revoked_at IS NULL AND g.expires_at>now()
  AND g.client_id=$2 AND g.resource=$3 AND g.scope='farejador.read'`;

async function issuePair(client: PoolClient, grantId: string) {
  const access = dotSecret('da_'), refresh = dotSecret('dr_');
  await client.query(`INSERT INTO network.dot_oauth_tokens(environment,grant_id,access_hash,refresh_hash)
    VALUES($1,$2,$3,$4)`,[env.FAREJADOR_ENV,grantId,dotHash(access),dotHash(refresh)]);
  return {access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:DOT_ACCESS_SECONDS,scope:DOT_SCOPE};
}

/** OAuth tokens are entirely separate from human/admin sessions. */
export async function exchangeDotToken(config: DotConfig, body: z.infer<typeof dotTokenBody>) {
  if (body.client_id !== config.clientId || body.resource !== config.resource) return null;
  const isCode = body.grant_type === 'authorization_code';
  if (isCode ? !/^dc_[a-f0-9]{64}$/.test(body.code ?? '') || !body.code_verifier || !body.redirect_uri
    : !/^dr_[a-f0-9]{64}$/.test(body.refresh_token ?? '')) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const base = [env.FAREJADOR_ENV,config.clientId,config.resource];
    const found = isCode
      ? await client.query<{id:string;code_challenge:string;redirect_uri:string;code_used_at:Date|null;valid:boolean}>(
        `SELECT g.id,g.code_challenge,g.redirect_uri,g.code_used_at,g.code_expires_at>now() valid
         FROM network.dot_oauth_grants g ${activeOwner} WHERE ${activeGrant} AND g.code_hash=$4 FOR UPDATE OF g`,
        [...base,dotHash(body.code!)])
      : await client.query<{id:string;token_id:string;rotated_at:Date|null}>(
        `SELECT g.id,t.id token_id,t.rotated_at FROM network.dot_oauth_grants g
         JOIN network.dot_oauth_tokens t ON t.grant_id=g.id AND t.environment=g.environment
         ${activeOwner} WHERE ${activeGrant} AND t.refresh_hash=$4 FOR UPDATE OF g,t`,
        [...base,dotHash(body.refresh_token!)]);
    const row = found.rows[0];
    if (!row) { await client.query('ROLLBACK'); return null; }
    if (isCode && 'code_challenge' in row) {
      const received = createHash('sha256').update(body.code_verifier!).digest('base64url');
      if (row.redirect_uri !== body.redirect_uri || received.length !== row.code_challenge.length
        || !timingSafeEqual(Buffer.from(received),Buffer.from(row.code_challenge)) || !row.valid || row.code_used_at) {
        await client.query('ROLLBACK'); return null;
      }
      await client.query('UPDATE network.dot_oauth_grants SET code_used_at=now() WHERE id=$1 AND environment=$2',[row.id,env.FAREJADOR_ENV]);
    } else if ('rotated_at' in row) {
      if (row.rotated_at) {
        await client.query('UPDATE network.dot_oauth_grants SET revoked_at=now() WHERE id=$1 AND environment=$2',[row.id,env.FAREJADOR_ENV]);
        await client.query('COMMIT'); return null;
      }
      await client.query('UPDATE network.dot_oauth_tokens SET rotated_at=now() WHERE id=$1 AND environment=$2',[row.token_id,env.FAREJADOR_ENV]);
    }
    const result = await issuePair(client,row.id);
    await client.query('COMMIT'); return result;
  } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
  finally { client.release(); }
}

export async function validateDotAccess(config: DotConfig, token: string): Promise<DotIdentity|null> {
  if (!/^da_[a-f0-9]{64}$/.test(token)) return null;
  const result = await pool.query<DotIdentity>(`SELECT g.id grant_id,g.person_id,g.collaborator_id
    FROM network.dot_oauth_grants g JOIN network.dot_oauth_tokens t ON t.grant_id=g.id AND t.environment=g.environment
    ${activeOwner} WHERE ${activeGrant} AND t.access_hash=$4 AND t.rotated_at IS NULL AND t.access_expires_at>now()`,
  [env.FAREJADOR_ENV,config.clientId,config.resource,dotHash(token)]);
  return result.rows[0] ?? null;
}
export async function revokeDotToken(config: DotConfig, token: string) {
  if (!/^(da|dr)_[a-f0-9]{64}$/.test(token)) return;
  await pool.query(`UPDATE network.dot_oauth_grants g SET revoked_at=COALESCE(g.revoked_at,now())
    FROM network.dot_oauth_tokens t WHERE t.grant_id=g.id AND t.environment=g.environment
      AND g.environment=$1 AND g.client_id=$2 AND g.resource=$3 AND (t.access_hash=$4 OR t.refresh_hash=$4)`,
  [env.FAREJADOR_ENV,config.clientId,config.resource,dotHash(token)]);
}
export async function listDotConnections(personId: string) {
  return (await pool.query(`SELECT id,created_at,expires_at,revoked_at FROM network.dot_oauth_grants
    WHERE environment=$1 AND person_id=$2 AND code_used_at IS NOT NULL
    ORDER BY created_at DESC LIMIT 50`,[env.FAREJADOR_ENV,personId])).rows;
}
export async function revokeDotConnection(personId: string, id: string) {
  await pool.query(`UPDATE network.dot_oauth_grants SET revoked_at=COALESCE(revoked_at,now())
    WHERE environment=$1 AND person_id=$2 AND id=$3`,[env.FAREJADOR_ENV,personId,id]);
}
