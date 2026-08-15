import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { hashPassword, verifyPassword } from '../../parceiro/password.js';

export type ChangeCaixaPasswordResult =
  | 'changed'
  | 'invalid_current_password'
  | 'same_password'
  | 'account_not_found';

/** Troca a senha da pessoa e encerra todas as sessÃµes operacionais dela. */
export async function changeCaixaPassword(
  environment: 'prod' | 'test',
  personId: string,
  currentPassword: string,
  newPassword: string,
  dbPool: Pool = defaultPool,
): Promise<ChangeCaixaPasswordResult> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const person = await client.query<{ password_hash: string | null }>(
      `SELECT password_hash FROM network.partner_people
        WHERE id=$2 AND environment=$1 AND revoked_at IS NULL FOR UPDATE`,
      [environment, personId],
    );
    const storedHash = person.rows[0]?.password_hash;
    if (!storedHash) { await client.query('ROLLBACK'); return 'account_not_found'; }
    if (!await verifyPassword(currentPassword, storedHash)) {
      await client.query('ROLLBACK'); return 'invalid_current_password';
    }
    if (await verifyPassword(newPassword, storedHash)) {
      await client.query('ROLLBACK'); return 'same_password';
    }
    const passwordHash = await hashPassword(newPassword);
    await client.query(
      `UPDATE network.partner_people SET password_hash=$3,password_set_at=now()
        WHERE id=$2 AND environment=$1 AND revoked_at IS NULL`,
      [environment, personId, passwordHash],
    );
    await client.query(
      `UPDATE network.partner_access_tokens
          SET login_password_hash=$3,login_password_set_at=now()
        WHERE person_id=$2 AND environment=$1 AND revoked_at IS NULL`,
      [environment, personId, passwordHash],
    );
    await client.query(
      `UPDATE network.matriz_staff_sessions SET revoked_at=now()
        WHERE person_id=$2 AND environment=$1 AND revoked_at IS NULL`,
      [environment, personId],
    );
    await client.query('COMMIT'); return 'changed';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); throw error;
  } finally { client.release(); }
}
