import type { Pool,PoolClient } from 'pg';
import { env } from '../../../shared/config/env.js';
import { dotConfig } from '../config.js';
import type { DotIdentity } from '../token-store.js';

export async function withSubscriptionLock<T>(db:Pool,identity:DotIdentity,work:(client:PoolClient,grantExpires:Date)=>Promise<T>) {
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${env.FAREJADOR_ENV}:${identity.person_id}:dot-events`]);
    const config=dotConfig()!;
    const grant=await client.query<{expires_at:Date}>(`SELECT g.expires_at FROM network.dot_oauth_grants g
      JOIN network.partner_people p ON p.id=g.person_id AND p.environment=g.environment AND p.revoked_at IS NULL
      JOIN network.matriz_collaborators c ON c.id=g.collaborator_id AND c.environment=g.environment
        AND c.person_id=g.person_id AND c.panel_role='owner' AND c.revoked_at IS NULL
      WHERE g.environment=$1 AND g.id=$2 AND g.person_id=$3 AND g.collaborator_id=$4
        AND g.client_id=$5 AND g.resource=$6 AND g.scope='farejador.read'
        AND g.revoked_at IS NULL AND g.expires_at>now() AND g.code_used_at IS NOT NULL`,
    [env.FAREJADOR_ENV,identity.grant_id,identity.person_id,identity.collaborator_id,config.clientId,config.resource]);
    if(!grant.rows[0])throw new Error('authorization_revoked');
    const result=await work(client,grant.rows[0].expires_at);
    await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
