'use strict';

const { createHash } = require('node:crypto');
const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const MANIFEST_HEADER = '# Farejador migration checksums v1';
const GAP_PREFIX = '# documented-gap: ';

function parseMigrationFilename(name) {
  const match = /^(\d{4})([a-z]*)_[a-z0-9_]+\.sql$/.exec(name);
  if (!match) return null;
  return { order: Number(match[1]), suffix: match[2] };
}

function compareMigrations(left, right) {
  const a = parseMigrationFilename(left);
  const b = parseMigrationFilename(right);
  if (!a || !b) return left.localeCompare(right);
  return a.order - b.order || a.suffix.localeCompare(b.suffix);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function parseManifest(content) {
  const entries = new Map();
  const documentedGaps = [];
  const errors = [];
  const lines = content.split(/\r?\n/);
  if (lines[0] !== MANIFEST_HEADER) errors.push('cabecalho do manifesto invalido');

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line === MANIFEST_HEADER) continue;
    if (line.startsWith(GAP_PREFIX)) {
      documentedGaps.push(line.slice(GAP_PREFIX.length));
      continue;
    }
    if (line.startsWith('#')) continue;
    const match = /^([0-9a-f]{64})  (.+\.sql)$/.exec(line);
    if (!match) {
      errors.push(`linha ${index + 1} invalida no manifesto`);
      continue;
    }
    if (entries.has(match[2])) errors.push(`migration duplicada no manifesto: ${match[2]}`);
    entries.set(match[2], match[1]);
  }
  return { documentedGaps, entries, errors };
}

function auditMigrationManifest(root) {
  const migrationsDir = path.join(root, 'db', 'migrations');
  const manifestPath = path.join(migrationsDir, 'manifest.sha256');
  const errors = [];
  let parsed;
  try {
    parsed = parseManifest(readFileSync(manifestPath, 'utf8'));
    errors.push(...parsed.errors);
  } catch (error) {
    return {
      ok: false,
      files: 0,
      latest: '',
      errors: [`manifesto ausente ou ilegivel: ${error.message}`],
      documentedGaps: [],
    };
  }

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort(compareMigrations);
  const keys = new Set();
  for (const file of files) {
    const parsedName = parseMigrationFilename(file);
    if (!parsedName) {
      errors.push(`nome de migration invalido: ${file}`);
      continue;
    }
    const key = `${parsedName.order}:${parsedName.suffix}`;
    if (keys.has(key)) errors.push(`ordem de migration duplicada: ${key}`);
    keys.add(key);
    const expected = parsed.entries.get(file);
    if (!expected) {
      errors.push(`migration fora do manifesto: ${file}`);
      continue;
    }
    const actual = sha256(path.join(migrationsDir, file));
    if (actual !== expected) errors.push(`checksum divergente: ${file}`);
  }

  for (const file of parsed.entries.keys()) {
    if (!files.includes(file)) errors.push(`arquivo do manifesto ausente: ${file}`);
  }

  const numericOrders = [...new Set(files.map(parseMigrationFilename).filter(Boolean).map((item) => item.order))];
  const latestOrder = Math.max(...numericOrders);
  const actualGaps = [];
  for (let order = 1; order <= latestOrder; order += 1) {
    if (!numericOrders.includes(order)) actualGaps.push(String(order).padStart(4, '0'));
  }
  if (actualGaps.join(',') !== parsed.documentedGaps.join(',')) {
    errors.push(`gaps divergentes: atual=${actualGaps.join(',') || 'nenhum'} documentado=${parsed.documentedGaps.join(',') || 'nenhum'}`);
  }

  return {
    ok: errors.length === 0,
    files: files.length,
    latest: files.at(-1) ?? '',
    errors,
    documentedGaps: parsed.documentedGaps,
  };
}

if (require.main === module) {
  const result = auditMigrationManifest(path.resolve(__dirname, '..'));
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) console.log(`OK: ${result.files} migrations verificadas; ultima=${result.latest}; gaps=${result.documentedGaps.join(',')}`);
  else result.errors.forEach((error) => console.error(`ERRO: ${error}`));
  if (!result.ok) process.exitCode = 1;
}

module.exports = { auditMigrationManifest, compareMigrations, parseMigrationFilename, parseManifest };
