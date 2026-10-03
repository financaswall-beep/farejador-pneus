import type { Pool } from 'pg';

/** Aguarda bloqueio real no PostgreSQL, sem depender da velocidade da máquina. */
export async function waitForDatabaseBlock(pool: Pool, blockerPid: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))`, [blockerPid]);
    if (result.rowCount) return result.rows[0]!.pid;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('A segunda operação não chegou à trava do banco');
}

/** Executa o cancelamento real e segura apenas seu COMMIT, com todas as travas adquiridas. */
export function pauseNextCommit(pool: Pool) {
  let resume!: () => void, signal!: (pid: number) => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const reached = new Promise<number>(resolve => { signal = resolve; });
  const db = new Proxy(pool, {
    get(target, key) {
      if (key === 'connect') return async () => {
        const client = await target.connect();
        const pid = (await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        return new Proxy(client, {
          get(connection, property) {
            if (property === 'query') return async (...args: any[]) => {
              if (args[0] === 'COMMIT') { signal(pid); await gate; }
              return (connection.query as any)(...args);
            };
            const value = Reflect.get(connection, property);
            return typeof value === 'function' ? value.bind(connection) : value;
          },
        });
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, reached, resume };
}
