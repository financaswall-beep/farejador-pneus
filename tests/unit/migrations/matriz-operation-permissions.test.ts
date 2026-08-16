import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('db/migrations/0172_matriz_operation_permissions.sql'), 'utf8',
);
const stockMigration = readFileSync(
  resolve('db/migrations/0176_matriz_operation_stock_permission.sql'), 'utf8',
);
const auth = readFileSync(resolve('src/admin/caixa/operation-auth.ts'), 'utf8');
const sessions = readFileSync(resolve('src/admin/caixa/queries.ts'), 'utf8');

describe('permissÃµes individuais da Matriz na OperaÃ§Ã£o', () => {
  it('cria uma tabela isolada por ambiente e inacessÃ­vel ao parceiro', () => {
    expect(migration).toContain('network.matriz_collaborator_operation_permissions');
    expect(migration).toContain('ops.validate_env_match');
    expect(migration).toContain('ops.enforce_environment_immutable');
    expect(migration).toContain('REVOKE ALL');
    expect(migration).toContain('farejador_partner_app');
  });

  it('preserva o cargo legado quando ainda nÃ£o existe configuraÃ§Ã£o individual', () => {
    expect(auth).toContain('matrixRow.allow_vendas ?? canSell');
    expect(auth).toContain('matrixRow.allow_entregas ?? isCourier');
    expect(sessions).toContain('overrides?.financeiro ?? legacy.financeiro');
    expect(sessions).toContain('overrides?.estoque ?? legacy.estoque');
  });

  it('revalida os mÃ³dulos em toda sessÃ£o da Matriz', () => {
    expect(sessions).toContain('matriz_collaborator_operation_permissions');
    expect(sessions).toContain('op.allow_vendas,op.allow_estoque,op.allow_entregas,op.allow_financeiro');
  });

  it('adiciona o Estoque com padrão fechado e sem expor custo', () => {
    expect(stockMigration).toContain('ADD COLUMN IF NOT EXISTS allow_estoque');
    expect(stockMigration).toContain('NOT NULL DEFAULT false');
    expect(stockMigration).toContain('matriz_operation_stock_nullable');
  });
});
