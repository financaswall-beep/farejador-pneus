import type { Pool, PoolClient } from 'pg';

export type PublisherDatabase = Pool | PoolClient;

/** O painel abre a transação. O MCP compartilha a transação de permissão e idempotência. */
export async function publisherTransaction<T>(db: PublisherDatabase, work: (client: PoolClient) => Promise<T>) {
  if ('release' in db) return work(db);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
