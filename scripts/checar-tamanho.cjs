#!/usr/bin/env node
/**
 * FISCAL DE TAMANHO — repo inteiro (teto de 300 linhas por arquivo de producao).
 *
 * Historia: a regra nasceu no painel do parceiro (obra
 * PLANO_REFATORACAO_PAINEL_300_2026-06-10.md, app.js 4755→24 modulos) e em
 * 2026-07-05 foi estendida pro codigo de producao inteiro (censo
 * docs/CENSO_TAMANHO_ARQUIVOS_2026-07-05.md).
 *
 * O que e vigiado (codigo de PRODUCAO):
 *   - src\**\*.ts
 *   - painel/public/*.js e parceiro/public/*.js
 * Fora da regra (de proposito): tests/, scripts/ (provas sao roteiro linear),
 * db/migrations (registro historico), *.html e *.css (fatiar exige tecnica
 * propria — ficam pra obra futura).
 *
 * Regras:
 *   1. Arquivo NOVO (fora de scripts/teto-herdado.json): teto universal de 300.
 *   2. Arquivo HERDADO (na lista): teto CONGELADO no censo + folga 25 — pode
 *      encolher, NAO pode engordar. Quem fatiar pra baixo de 300 REMOVE a
 *      entrada do JSON no mesmo commit (o fiscal avisa quando da).
 *
 * Uso: node scripts/checar-tamanho.cjs   (ou: npm run checar-tamanho)
 * Sai com codigo 1 se qualquer arquivo estourar o teto.
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const TETO_UNIVERSAL = 300;
const HERDADO_PATH = path.join(__dirname, 'teto-herdado.json');

function contarLinhas(arquivo) {
  // Mesma semântica de `wc -l`: newline final não cria linha extra.
  const texto = fs.readFileSync(arquivo, 'utf8');
  const linhas = texto.split(/\r?\n/);
  if (linhas.length > 0 && linhas[linhas.length - 1] === '') linhas.pop();
  return linhas.length;
}

function lerHerdados() {
  if (!fs.existsSync(HERDADO_PATH)) return {};
  try {
    const json = JSON.parse(fs.readFileSync(HERDADO_PATH, 'utf8'));
    return json.tetos || {};
  } catch (err) {
    console.error(`[FALHA] teto-herdado.json ilegível: ${err.message}`);
    process.exit(1);
  }
}

function walk(dir) {
  let saida = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) saida = saida.concat(walk(p));
    else saida.push(p);
  }
  return saida;
}

function alvosDeProducao() {
  const alvos = [];
  for (const f of walk(path.join(RAIZ, 'src'))) {
    if (f.endsWith('.ts')) alvos.push(f);
  }
  for (const dir of ['painel/public', 'parceiro/public']) {
    const abs = path.join(RAIZ, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith('.js')) alvos.push(path.join(abs, f));
    }
  }
  return alvos.sort();
}

function relativo(arquivo) {
  return path.relative(RAIZ, arquivo).split(path.sep).join('/');
}

function main() {
  const herdados = lerHerdados();
  const alvos = alvosDeProducao();

  if (alvos.length === 0) {
    console.error('[FALHA] nenhum arquivo de produção encontrado — checar caminhos do fiscal.');
    process.exit(1);
  }

  let estourou = false;
  const violacoes = [];
  const censoHerdado = [];
  let quitados = 0;

  for (const arquivo of alvos) {
    const rel = relativo(arquivo);
    const linhas = contarLinhas(arquivo);
    const ehHerdado = Object.prototype.hasOwnProperty.call(herdados, rel);
    const teto = ehHerdado ? herdados[rel] : TETO_UNIVERSAL;

    if (linhas > teto) {
      estourou = true;
      violacoes.push({ rel, linhas, teto, ehHerdado });
    }
    if (ehHerdado) {
      censoHerdado.push({ rel, linhas, teto });
      if (linhas <= TETO_UNIVERSAL) quitados += 1;
    }
  }

  // Entrada herdada apontando pra arquivo que não existe mais = lista suja.
  for (const rel of Object.keys(herdados)) {
    if (!fs.existsSync(path.join(RAIZ, rel))) {
      estourou = true;
      violacoes.push({ rel, linhas: 0, teto: herdados[rel], fantasma: true });
    }
  }

  console.log(`Fiscal de tamanho — ${alvos.length} arquivos de produção vigiados (teto ${TETO_UNIVERSAL}; herdados: ${censoHerdado.length}).`);

  if (censoHerdado.length > 0) {
    console.log('\nCenso dos herdados (divida catalogada — pode encolher, nao pode engordar):');
    for (const c of censoHerdado.sort((a, b) => b.linhas - a.linhas)) {
      const status = c.linhas <= TETO_UNIVERSAL ? 'QUITADO — remover do teto-herdado.json' : `teto congelado ${c.teto}`;
      console.log(`  [CENSO] ${c.rel}: ${c.linhas} linhas (${status})`);
    }
    if (quitados > 0) {
      console.log(`  → ${quitados} arquivo(s) já abaixo de 300: limpar a(s) entrada(s) no teto-herdado.json.`);
    }
  }

  if (violacoes.length > 0) {
    console.error('');
    for (const v of violacoes.sort((a, b) => b.linhas - a.linhas)) {
      if (v.fantasma) {
        console.error(`[FALHA] ${v.rel}: está no teto-herdado.json mas não existe mais — remover a entrada.`);
      } else if (v.ehHerdado) {
        console.error(`[FALHA] ${v.rel}: ${v.linhas} linhas — HERDADO com teto congelado em ${v.teto}. Arquivo da lista de refatoração NÃO pode engordar: fatie o que ia adicionar (ou extraia o mesmo tanto).`);
      } else {
        console.error(`[FALHA] ${v.rel}: ${v.linhas} linhas — acima do teto universal de ${TETO_UNIVERSAL}. Arquivo novo nasce fatiado: dividir por assunto antes de commitar.`);
      }
    }
    console.error('\n[FALHA] fiscal de tamanho: refatore antes de commitar (censo 2026-07-05 + regra da obra de 06-10).');
    process.exit(1);
  }

  console.log('\n[OK] fiscal de tamanho: todos os arquivos dentro do teto.');
}

main();
