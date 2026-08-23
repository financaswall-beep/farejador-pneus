#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const argumentos = process.argv.slice(2);
const indiceRaiz = argumentos.indexOf('--raiz');
const indiceBaseline = argumentos.indexOf('--baseline');
const listar = argumentos.includes('--listar');
const raiz = path.resolve(
  indiceRaiz >= 0 ? argumentos[indiceRaiz + 1] : path.join(__dirname, '..'),
);
const arquivoBaseline = path.resolve(
  indiceBaseline >= 0
    ? argumentos[indiceBaseline + 1]
    : path.join(raiz, 'scripts', 'pools-herdados.json'),
);
const raizSrc = path.join(raiz, 'src');
const alvoPoolAdmin = path.join(raizSrc, 'persistence', 'db.ts');

function caminhoProjeto(arquivo) {
  return path.relative(raiz, arquivo).split(path.sep).join('/');
}

function falhar(mensagem) {
  console.error(`\n[pool-gate] FALHA: ${mensagem}`);
  process.exitCode = 1;
}

function ehArquivo(arquivo) {
  try {
    return fs.statSync(arquivo).isFile();
  } catch {
    return false;
  }
}

function resolverImportLocal(importador, especificador) {
  if (!especificador.startsWith('.')) return null;

  const base = path.resolve(path.dirname(importador), especificador);
  const extensao = path.extname(base);
  const candidatos = [];

  if (extensao) {
    candidatos.push(base);
    const semExtensao = base.slice(0, -extensao.length);
    if (['.js', '.jsx', '.mjs', '.cjs'].includes(extensao)) {
      candidatos.push(
        `${semExtensao}.ts`,
        `${semExtensao}.tsx`,
        `${semExtensao}.mts`,
        `${semExtensao}.cts`,
      );
    }
  } else {
    candidatos.push(
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.mts`,
      `${base}.cts`,
      `${base}.js`,
      `${base}.mjs`,
      `${base}.cjs`,
      path.join(base, 'index.ts'),
      path.join(base, 'index.tsx'),
      path.join(base, 'index.js'),
    );
  }

  const resolvido = candidatos.find(ehArquivo);
  if (!resolvido) return null;

  const absoluto = path.resolve(resolvido);
  const relativoSrc = path.relative(raizSrc, absoluto);
  if (relativoSrc.startsWith('..') || path.isAbsolute(relativoSrc)) return null;
  return absoluto;
}

function importacaoEhSomenteTipo(no) {
  if (ts.isImportDeclaration(no)) {
    const clausula = no.importClause;
    if (!clausula) return false;
    if (clausula.isTypeOnly) return true;
    if (clausula.name || !clausula.namedBindings) return false;
    if (ts.isNamespaceImport(clausula.namedBindings)) return false;
    return clausula.namedBindings.elements.every((item) => item.isTypeOnly);
  }

  if (ts.isExportDeclaration(no)) {
    if (no.isTypeOnly) return true;
    if (!no.exportClause || !ts.isNamedExports(no.exportClause)) return false;
    return no.exportClause.elements.every((item) => item.isTypeOnly);
  }

  return false;
}

function listarEspecificadores(arquivo) {
  const texto = fs.readFileSync(arquivo, 'utf8');
  const fonte = ts.createSourceFile(
    arquivo,
    texto,
    ts.ScriptTarget.Latest,
    true,
    arquivo.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const encontrados = new Set();

  function visitar(no) {
    if (
      (ts.isImportDeclaration(no) || ts.isExportDeclaration(no))
      && no.moduleSpecifier
      && ts.isStringLiteralLike(no.moduleSpecifier)
      && !importacaoEhSomenteTipo(no)
    ) {
      encontrados.add(no.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(no)
      && !no.isTypeOnly
      && ts.isExternalModuleReference(no.moduleReference)
      && no.moduleReference.expression
      && ts.isStringLiteralLike(no.moduleReference.expression)
    ) {
      encontrados.add(no.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(no)
      && no.arguments.length === 1
      && ts.isStringLiteralLike(no.arguments[0])
      && (
        no.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(no.expression) && no.expression.text === 'require')
      )
    ) {
      encontrados.add(no.arguments[0].text);
    }

    ts.forEachChild(no, visitar);
  }

  visitar(fonte);
  return [...encontrados];
}

function obterEntradas() {
  const pastaParceiro = path.join(raizSrc, 'parceiro');
  return fs.readdirSync(pastaParceiro, { withFileTypes: true })
    .filter((item) => item.isFile() && /^route.*\.ts$/.test(item.name))
    .map((item) => path.join(pastaParceiro, item.name))
    .sort();
}

function mapearViolacoes() {
  const entradas = obterEntradas();
  const fila = entradas.map((arquivo) => ({ arquivo, trilha: [arquivo] }));
  const visitados = new Set();
  const violacoes = new Map();

  while (fila.length > 0) {
    const atual = fila.shift();
    if (visitados.has(atual.arquivo)) continue;
    visitados.add(atual.arquivo);

    for (const especificador of listarEspecificadores(atual.arquivo)) {
      const dependencia = resolverImportLocal(atual.arquivo, especificador);
      if (!dependencia) continue;

      if (path.resolve(dependencia) === path.resolve(alvoPoolAdmin)) {
        const importador = caminhoProjeto(atual.arquivo);
        if (!violacoes.has(importador)) {
          violacoes.set(importador, atual.trilha.map(caminhoProjeto));
        }
        continue;
      }

      if (!visitados.has(dependencia)) {
        fila.push({ arquivo: dependencia, trilha: [...atual.trilha, dependencia] });
      }
    }
  }

  return {
    entradas: entradas.map(caminhoProjeto),
    visitados: visitados.size,
    violacoes,
  };
}

function lerBaseline() {
  if (!ehArquivo(arquivoBaseline)) {
    throw new Error(`baseline ausente: ${caminhoProjeto(arquivoBaseline)}`);
  }

  const conteudo = JSON.parse(fs.readFileSync(arquivoBaseline, 'utf8'));
  const permitidos = conteudo.importadoresPermitidosHerdados;
  if (!Array.isArray(permitidos) || permitidos.some((item) => typeof item !== 'string')) {
    throw new Error('importadoresPermitidosHerdados deve ser uma lista de caminhos');
  }
  if (new Set(permitidos).size !== permitidos.length) {
    throw new Error('baseline contém caminhos duplicados');
  }

  const ordenados = [...permitidos].sort();
  if (JSON.stringify(ordenados) !== JSON.stringify(permitidos)) {
    throw new Error('baseline deve permanecer em ordem alfabética');
  }
  return permitidos;
}

try {
  const resultado = mapearViolacoes();
  const atuais = [...resultado.violacoes.keys()].sort();

  if (listar) {
    console.log(JSON.stringify({
      entradas: resultado.entradas,
      modulosVisitados: resultado.visitados,
      importadoresPoolAdmin: atuais.map((importador) => ({
        importador,
        trilha: resultado.violacoes.get(importador),
      })),
    }, null, 2));
    process.exit(0);
  }

  const herdados = lerBaseline();
  const herdadosSet = new Set(herdados);
  const atuaisSet = new Set(atuais);
  const novos = atuais.filter((item) => !herdadosSet.has(item));
  const removidos = herdados.filter((item) => !atuaisSet.has(item));

  for (const importador of novos) {
    const trilha = resultado.violacoes.get(importador).join(' -> ');
    console.error(`\nNOVO uso do pool admin: ${importador}`);
    console.error(`Trilha: ${trilha} -> src/persistence/db.ts`);
  }
  if (novos.length > 0) {
    falhar('rota do parceiro ganhou dependência nova do pool administrativo');
  }

  if (removidos.length > 0) {
    console.error(`\nDívida removida do código: ${removidos.join(', ')}`);
    falhar('remova também essas exceções de scripts/pools-herdados.json');
  }

  if (process.exitCode !== 1) {
    console.log(
      `[pool-gate] OK: ${resultado.entradas.length} rotas, `
      + `${resultado.visitados} módulos, ${atuais.length} exceções herdadas congeladas.`,
    );
  }
} catch (erro) {
  falhar(erro instanceof Error ? erro.message : String(erro));
}
