import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { MatrizAdminContext } from '../session.js';
import { DOT_SCOPE } from './config.js';
import type { DotAuthorization } from './oauth-validation.js';

export const dotHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const dotSecret = (prefix = '') => prefix + randomBytes(32).toString('hex');

export async function createDotConsent(context: MatrizAdminContext, session: string, authorization: DotAuthorization) {
  const token = dotSecret();
  await pool.query(`DELETE FROM network.dot_oauth_requests WHERE environment=$1 AND expires_at<now()-interval '1 day'`,[env.FAREJADOR_ENV]);
  await pool.query(`INSERT INTO network.dot_oauth_requests
    (environment,request_hash,session_hash,person_id,collaborator_id,request_params)
    VALUES($1,$2,$3,$4,$5,$6)`,[env.FAREJADOR_ENV,dotHash(token),dotHash(session),context.personId,context.collaboratorId,authorization]);
  return token;
}

export async function consumeDotConsent(context: MatrizAdminContext, session: string, token: string, allow: boolean) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize against password resets and role/revocation changes.
    const owner = await client.query(`SELECT mc.id FROM network.matriz_collaborators mc
      JOIN network.partner_people p ON p.id=mc.person_id AND p.environment=mc.environment
      WHERE mc.environment=$1 AND mc.id=$2 AND mc.person_id=$3 AND mc.panel_role='owner'
        AND mc.revoked_at IS NULL AND p.revoked_at IS NULL FOR SHARE OF mc,p`,
    [env.FAREJADOR_ENV,context.collaboratorId,context.personId]);
    if (!owner.rows.length) { await client.query('ROLLBACK'); return null; }
    const request = await client.query<{params:DotAuthorization}>(`UPDATE network.dot_oauth_requests SET consumed_at=now()
      WHERE environment=$1 AND request_hash=$2 AND session_hash=$3 AND person_id=$4 AND collaborator_id=$5
        AND expires_at>now() AND consumed_at IS NULL RETURNING request_params AS params`,
    [env.FAREJADOR_ENV,dotHash(token),dotHash(session),context.personId,context.collaboratorId]);
    const authorization = request.rows[0]?.params;
    if (!authorization) { await client.query('ROLLBACK'); return null; }
    const code = allow ? dotSecret('dc_') : null;
    if (code) await client.query(`INSERT INTO network.dot_oauth_grants
      (environment,person_id,collaborator_id,client_id,resource,scope,code_hash,code_challenge,redirect_uri)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[env.FAREJADOR_ENV,context.personId,context.collaboratorId,
      authorization.client_id,authorization.resource,DOT_SCOPE,dotHash(code),authorization.code_challenge,authorization.redirect_uri]);
    await client.query('COMMIT');
    return {authorization,code};
  } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
  finally { client.release(); }
}
