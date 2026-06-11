#!/usr/bin/env node
/**
 * PROVA DE ENDPOINTS — painel do parceiro (obra PLANO_REFATORACAO_PAINEL_300_2026-06-10.md).
 *
 * O QUE PROVA: nenhum contrato de rede mudou na refatoracao. Extrai de todos os
 * app*.js (na ordem do index.html):
 *   call: o texto COMPLETO (parenteses balanceados, espacos normalizados) de cada
 *         chamada this.api(...), fetch(...) e new EventSource(...) — pega path,
 *         method, headers e body como estao escritos;
 *   lit:  todo literal de string/template contendo "/api/" — pega montagem de URL
 *         feita FORA da chamada (ex.: a url do SSE do chat/foto).
 * A lista ordenada (com duplicatas — multiset) e comparada ao baseline. MOVER
 * codigo de arquivo nao muda a lista; EDITAR uma chamada muda -> REPROVADO.
 *
 * Limite assumido: o scanner pula comentarios mas nao entende regex literal com
 * aspas dentro (nao existe hoje no app.js). Como baseline e checagem usam o MESMO
 * extrator, a comparacao continua valida mesmo nesse canto.
 *
 * USO:
 *   node scripts/prova-endpoints-painel.cjs                    -> compara com baseline (exit 1 se diferente)
 *   node scripts/prova-endpoints-painel.cjs --gravar-baseline  -> (re)grava scripts/baseline-endpoints-painel.json
 *   node scripts/prova-endpoints-painel.cjs --dir <pasta>      -> outra pasta public (auto-teste/sabotagem)
 *   node scripts/prova-endpoints-painel.cjs --listar           -> imprime a lista extraida
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'baseline-endpoints-painel.json');

function args() {
  const a = process.argv.slice(2);
  const dirIdx = a.indexOf('--dir');
  return {
    gravar: a.includes('--gravar-baseline'),
    listar: a.includes('--listar'),
    dir: dirIdx >= 0 ? path.resolve(a[dirIdx + 1]) : path.join(RAIZ, 'parceiro', 'public'),
  };
}

function listarScriptsDoIndex(publicDir) {
  const indexPath = path.join(publicDir, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  const re = /<script[^>]+src="\.\/(app[^"?]*\.js)(?:\?[^"]*)?"/g;
  const arquivos = [];
  let m;
  while ((m = re.exec(html))) arquivos.push(m[1]);
  if (arquivos.length === 0) throw new Error(`nenhum <script src="./app*.js"> em ${indexPath}`);
  return arquivos;
}

/**
 * Acha o ')' que fecha o '(' em idxAbre, respeitando strings, templates
 * (com ${} aninhado), objetos dentro de ${} e comentarios.
 */
function acharFechamento(src, idxAbre) {
  const frames = [{ tipo: 'code', parens: 0, braces: 0 }];
  for (let i = idxAbre; i < src.length; i++) {
    const topo = frames[frames.length - 1];
    const c = src[i];
    if (topo.tipo === 'code') {
      if (c === '(') topo.parens++;
      else if (c === ')') { topo.parens--; if (frames.length === 1 && topo.parens === 0) return i; }
      else if (c === '{') topo.braces++;
      else if (c === '}') { if (topo.braces > 0) topo.braces--; else if (frames.length > 1) frames.pop(); }
      else if (c === "'" || c === '"') frames.push({ tipo: 'str', aspas: c });
      else if (c === '`') frames.push({ tipo: 'tpl' });
      else if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; }
      else if (c === '/' && src[i + 1] === '*') { const f = src.indexOf('*/', i + 2); if (f === -1) return -1; i = f + 1; }
    } else if (topo.tipo === 'str') {
      if (c === '\\') i++;
      else if (c === topo.aspas || c === '\n') frames.pop();
    } else { // tpl
      if (c === '\\') i++;
      else if (c === '`') frames.pop();
      else if (c === '$' && src[i + 1] === '{') { frames.push({ tipo: 'code', parens: 0, braces: 0 }); i++; }
    }
  }
  return -1;
}

const PADROES = [
  { rotulo: 'this.api', re: /this\.api\(/g },
  { rotulo: 'fetch', re: /(?<![\w.$])fetch\(/g },
  { rotulo: 'EventSource', re: /new EventSource\(/g },
];

function extrairChamadas(src) {
  const itens = [];
  for (const p of PADROES) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(src))) {
      const idxAbre = m.index + m[0].length - 1;
      const fim = acharFechamento(src, idxAbre);
      if (fim === -1) throw new Error(`parentese sem fechamento apos ${p.rotulo} no offset ${m.index}`);
      itens.push('call:' + src.slice(m.index, fim + 1).replace(/\s+/g, ' ').trim());
    }
  }
  return itens;
}

/** Todo literal 'x', "x" ou `x` (texto bruto, com as expressoes ${} dentro) contendo /api/. */
function extrairLiteraisApi(src) {
  const itens = [];
  const frames = [{ tipo: 'code', braces: 0 }];
  let inicio = -1;
  for (let i = 0; i < src.length; i++) {
    const topo = frames[frames.length - 1];
    const c = src[i];
    if (topo.tipo === 'code') {
      if (c === "'" || c === '"') { frames.push({ tipo: 'str', aspas: c }); inicio = frames.length === 2 ? i : inicio; }
      else if (c === '`') { frames.push({ tipo: 'tpl' }); inicio = frames.length === 2 ? i : inicio; }
      else if (c === '{') topo.braces++;
      else if (c === '}') { if (topo.braces > 0) topo.braces--; else if (frames.length > 1) frames.pop(); }
      else if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; }
      else if (c === '/' && src[i + 1] === '*') { const f = src.indexOf('*/', i + 2); if (f === -1) break; i = f + 1; }
    } else if (topo.tipo === 'str') {
      if (c === '\\') i++;
      else if (c === topo.aspas || c === '\n') {
        frames.pop();
        if (frames.length === 1 && inicio >= 0) {
          const lit = src.slice(inicio, i + 1);
          if (lit.includes('/api/')) itens.push('lit:' + lit.replace(/\s+/g, ' ').trim());
          inicio = -1;
        }
      }
    } else { // tpl
      if (c === '\\') i++;
      else if (c === '`') {
        frames.pop();
        if (frames.length === 1 && inicio >= 0) {
          const lit = src.slice(inicio, i + 1);
          if (lit.includes('/api/')) itens.push('lit:' + lit.replace(/\s+/g, ' ').trim());
          inicio = -1;
        }
      } else if (c === '$' && src[i + 1] === '{') { frames.push({ tipo: 'code', braces: 0 }); i++; }
    }
  }
  return itens;
}

function gerarLista(publicDir) {
  const doIndex = listarScriptsDoIndex(publicDir);
  // Arquivo app*.js na pasta mas FORA do index.html = orfao (codigo morto perigoso) -> reprova.
  const naPasta = fs.readdirSync(publicDir).filter((f) => /^app(\.[\w-]+)?\.js$/.test(f));
  const orfaos = naPasta.filter((f) => !doIndex.includes(f));
  if (orfaos.length > 0) throw new Error(`app*.js fora do index.html (orfao): ${orfaos.join(', ')}`);

  const itens = [];
  for (const nome of doIndex) {
    const src = fs.readFileSync(path.join(publicDir, nome), 'utf8');
    itens.push(...extrairChamadas(src));
    itens.push(...extrairLiteraisApi(src));
  }
  return itens.sort();
}

function diffMultiset(antes, agora) {
  const conta = (arr) => arr.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
  const a = conta(antes); const b = conta(agora);
  const sumiram = []; const surgiram = [];
  for (const [item, n] of a) { const d = n - (b.get(item) || 0); for (let i = 0; i < d; i++) sumiram.push(item); }
  for (const [item, n] of b) { const d = n - (a.get(item) || 0); for (let i = 0; i < d; i++) surgiram.push(item); }
  return { sumiram, surgiram };
}

function main() {
  const { gravar, listar, dir } = args();
  const itens = gerarLista(dir);
  const calls = itens.filter((x) => x.startsWith('call:')).length;
  const lits = itens.length - calls;
  console.log(`[info] ${itens.length} itens de contrato (${calls} chamadas + ${lits} literais /api/)`);
  if (listar) for (const x of itens) console.log('  ' + x);

  if (gravar) {
    const baseline = { geradoEm: new Date().toISOString(), commitBase: 'c0d7913', total: itens.length, itens };
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`[OK] baseline gravado em ${path.relative(RAIZ, BASELINE_PATH)}`);
    return;
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.error('[FALHA] baseline nao existe. Gere com --gravar-baseline (so no passo 0!).');
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const { sumiram, surgiram } = diffMultiset(baseline.itens, itens);
  if (sumiram.length === 0 && surgiram.length === 0) {
    console.log(`[OK] CONTRATOS: lista identica ao baseline (${itens.length} itens).`);
    return;
  }
  for (const x of sumiram) console.error(`[FALHA] SUMIU:    ${x}`);
  for (const x of surgiram) console.error(`[FALHA] APARECEU: ${x}`);
  console.error(`\n[FALHA] CONTRATO DE REDE MUDOU: ${sumiram.length} sumiram, ${surgiram.length} apareceram. Passo REPROVADO (plano, secao 4 item 3).`);
  process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(`[FALHA] prova de endpoints nao rodou: ${err.message}`);
  process.exit(1);
}
