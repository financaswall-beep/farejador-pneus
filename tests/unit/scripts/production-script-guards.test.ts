import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function runScript(script: string, args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: 'postgres://guard-test.invalid/database',
      ...env,
    },
  });
}

describe('travas dos scripts operacionais', () => {
  it('bloqueia commit de migration em produção sem autorização específica', () => {
    const result = runScript(
      'scripts/apply-migration-file.cjs',
      ['db/migrations/0129_matriz_trip_number.sql', '--commit'],
      {
        FAREJADOR_ENV: 'prod',
        ALLOW_PROD_MIGRATION: '',
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ALLOW_PROD_MIGRATION=0129_matriz_trip_number.sql');
  });

  it('bloqueia criação de token em produção sem autorização da unidade', () => {
    const result = runScript(
      'scripts/gerar-token-parceiro.cjs',
      ['--slug=unidade-teste', '--env=prod'],
      {
        FAREJADOR_ENV: 'prod',
        COMMIT: '1',
        ALLOW_PROD_PARTNER_TOKEN: '',
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ALLOW_PROD_PARTNER_TOKEN=unidade-teste');
  });

  it('bloqueia reset de senha em produção sem autorização exata', () => {
    const result = runScript(
      'scripts/resetar-senha-parceiro.cjs',
      ['--slug=unidade-teste', '--username=operador', '--env=prod'],
      {
        FAREJADOR_ENV: 'prod',
        COMMIT: '1',
        ALLOW_PROD_PARTNER_PASSWORD_RESET: '',
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'ALLOW_PROD_PARTNER_PASSWORD_RESET=unidade-teste:operador',
    );
  });

  it('bloqueia o smoke 0094 fora do ambiente de teste', () => {
    const result = runScript('scripts/smoke-0094.cjs', [], {
      FAREJADOR_ENV: 'prod',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('só pode rodar com FAREJADOR_ENV=test');
  });
});
