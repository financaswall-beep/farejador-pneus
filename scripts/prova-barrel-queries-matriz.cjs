#!/usr/bin/env node
/**
 * PROVA DO BARREL — banco da matriz (obra 300, 2026-07-05).
 *
 * O queries.ts é uma porta de entrada (`export *` de 16 módulos). O ÚNICO modo
 * de falha silenciosa desse desenho (apontado pela banca): dois módulos
 * exportarem o MESMO nome — o TypeScript DERRUBA o símbolo do barrel sem erro
 * de compile e o importador recebe undefined em runtime.
 *
 * O que esta prova trava:
 *   1. Nenhum nome exportado por 2+ módulos queries-*.ts (duplicata = FALHA).
 *   2. Todo import de './queries.js' / '../painel/queries.js' no código de
 *      produção resolve pra um export real de exatamente 1 módulo.
 *   3. O barrel só contém `export *` dos módulos existentes (nada de lógica).
 *
 * Uso: node scripts/prova-barrel-queries-matriz.cjs   (exit 1 se furar)
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const DIR = path.join(RAIZ, 'src', 'admin', 'painel');

function falha(msg) { console.error(`[FALHA] ${msg}`); process.exit(1); }

// ── 1. exports de cada módulo ──
const modulos = fs.readdirSync(DIR).filter((f) => /^queries-[\w-]+\.ts$/.test(f)).sort();
if (modulos.length === 0) falha('nenhum queries-*.ts achado — obra desfeita?');
const dono = new Map(); // nome exportado -> módulo
const reDecl = /^export (?:async )?(?:function|const|class|type|interface|let|enum) ([A-Za-z0-9_]+)/;
for (const arq of modulos) {
  const linhas = fs.readFileSync(path.join(DIR, arq), 'utf8').split(/\r?\n/);
  for (const l of linhas) {
    const m = reDecl.exec(l);
    if (!m) continue;
    const nome = m[1];
    if (dono.has(nome)) falha(`export DUPLICADO "${nome}" em ${arq} e ${dono.get(nome)} — o barrel derruba o símbolo em silêncio!`);
    dono.set(nome, arq);
  }
}

// ── 2. barrel só re-exporta módulos existentes ──
const barrel = fs.readFileSync(path.join(DIR, 'queries.ts'), 'utf8').split(/\r?\n/);
const reExport = /^export \* from '\.\/(queries-[\w-]+)\.js';/;
const reexportados = new Set();
for (const l of barrel) {
  const m = reExport.exec(l);
  if (m) {
    if (!fs.existsSync(path.join(DIR, `${m[1]}.ts`))) falha(`barrel re-exporta ${m[1]}.js mas o .ts não existe`);
    reexportados.add(`${m[1]}.ts`);
  } else if (/^export /.test(l)) {
    falha(`barrel tem export que não é 'export * from ./queries-*.js': ${l} — lógica não mora na porta de entrada`);
  }
}
for (const arq of modulos) {
  if (!reexportados.has(arq)) falha(`módulo ${arq} existe mas não está no barrel — seus exports sumiram da porta`);
}

// ── 3. importadores do barrel resolvem ──
function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
// './queries.js' só é o barrel quando o importador mora em src/admin/painel/
// (ex.: entregador/route.ts tem um './queries.js' PRÓPRIO — não é o barrel).
let importsChecados = 0;
for (const arquivo of walk(path.join(RAIZ, 'src'))) {
  if (arquivo.endsWith(`${path.sep}queries.ts`) && arquivo.includes('painel')) continue;
  const noPainel = path.dirname(arquivo) === DIR;
  const reImport = noPainel
    ? /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'\.\/queries\.js'/g
    : /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'\.\.\/painel\/queries\.js'/g;
  const texto = fs.readFileSync(arquivo, 'utf8');
  let m;
  while ((m = reImport.exec(texto))) {
    for (let nome of m[1].split(',')) {
      nome = nome.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (!nome) continue;
      importsChecados += 1;
      if (!dono.has(nome)) falha(`${path.relative(RAIZ, arquivo)} importa "${nome}" do barrel, mas nenhum módulo exporta esse nome`);
    }
  }
}

console.log(`[OK] BARREL: ${modulos.length} módulos, ${dono.size} exports únicos (zero duplicata), ${importsChecados} imports de consumidores resolvidos.`);
