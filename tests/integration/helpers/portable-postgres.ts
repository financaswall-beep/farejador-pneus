import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve, sep } from 'node:path';
import { Pool } from 'pg';

const run = promisify(execFile);

/** Optional local PostgreSQL for machines without Docker. Never reads the app's DATABASE_URL. */
export async function startPortablePostgres(bin: string) {
  const base = resolve(tmpdir(), 'farejador-disposable-postgres');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'test-'));
  const data = join(directory, 'data');
  const executable = (name: string) => join(resolve(bin), `${name}${process.platform === 'win32' ? '.exe' : ''}`);
  const port = await new Promise<number>((done, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('test_port_unavailable'));
      server.close(error => error ? reject(error) : done(address.port));
    });
  });
  let started = false;
  let serverProcess: ChildProcess | undefined;
  let startupOutput = '';
  const stop = async () => {
    if (started) {
      await run(executable('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { windowsHide: true });
      started = false;
    }
    // Recursive cleanup is confined to the exact disposable directory allocated above.
    const target = resolve(directory);
    if (!target.startsWith(`${base}${sep}`)) throw new Error('unsafe_test_database_cleanup');
    await rm(target, { recursive: true, force: true });
  };
  try {
    // PostgreSQL 17: Unicode case folding também no Windows, independente do locale instalado no SO.
    await run(executable('initdb'), ['-D', data, '-U', 'test', '-A', 'trust', '--encoding=UTF8',
      '--locale=C', '--locale-provider=builtin', '--builtin-locale=C.UTF-8'], { windowsHide: true });
    serverProcess = spawn(executable('postgres'), ['-D', data, '-h', '127.0.0.1', '-p', String(port), '-F'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    serverProcess.stdout?.on('data', chunk => { startupOutput = (startupOutput + chunk).slice(-4000); });
    serverProcess.stderr?.on('data', chunk => { startupOutput = (startupOutput + chunk).slice(-4000); });
    started = true;
    const connectionString = `postgres://test:test@127.0.0.1:${port}/farejador_test`;
    const admin = new Pool({ connectionString: connectionString.replace('/farejador_test', '/postgres'), connectionTimeoutMillis: 500 });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (serverProcess.exitCode !== null) throw new Error(`test_postgres_start_failed: ${startupOutput}`);
        try { await admin.query('SELECT 1'); ready = true; break; }
        catch { await new Promise(done => setTimeout(done, 100)); }
      }
      if (!ready) throw new Error(`test_postgres_start_timeout: ${startupOutput}`);
      await admin.query('CREATE DATABASE farejador_test');
    }
    finally { await admin.end(); }
    return { getConnectionUri: () => connectionString, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
