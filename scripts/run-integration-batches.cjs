#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const integrationDir = path.join(root, 'tests', 'integration');
const vitestEntry = path.join(
  path.dirname(require.resolve('vitest/package.json')),
  'vitest.mjs',
);
const requestedBatchSize = Number(process.env.INTEGRATION_BATCH_SIZE ?? 12);
if (!Number.isInteger(requestedBatchSize) || requestedBatchSize < 1) {
  throw new Error('INTEGRATION_BATCH_SIZE precisa ser um inteiro positivo');
}

const filters = process.argv.slice(2);
const files = filters.length > 0 ? filters : readdirSync(integrationDir)
  .filter((name) => name.endsWith('.integration.test.ts'))
  .sort()
  .map((name) => path.join('tests', 'integration', name).replaceAll('\\', '/'));

if (files.length === 0) throw new Error('nenhum teste de integração encontrado');

const batches = [];
for (let index = 0; index < files.length; index += requestedBatchSize) {
  batches.push(files.slice(index, index + requestedBatchSize));
}

console.log(`[integration] ${files.length} arquivos em ${batches.length} lote(s) sequencial(is)`);
for (const [index, batch] of batches.entries()) {
  console.log(`[integration] lote ${index + 1}/${batches.length}: ${batch.length} arquivo(s)`);
  const run = spawnSync(process.execPath, [
    vitestEntry, 'run', '--config', 'vitest.integration.config.ts', ...batch,
  ], { cwd: root, env: process.env, stdio: 'inherit' });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
}

console.log(`[integration] APROVADO: ${files.length} arquivos concluídos`);
