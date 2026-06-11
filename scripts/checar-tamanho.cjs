#!/usr/bin/env node
/**
 * FISCAL DE TAMANHO — painel do parceiro (teto de 300 linhas por arquivo).
 *
 * Regra permanente do projeto (obra PLANO_REFATORACAO_PAINEL_300_2026-06-10.md):
 * nenhum parceiro/public/app*.js pode passar de 300 linhas.
 *
 * EXCEÇÃO TEMPORÁRIA durante a obra: scripts/obra-painel-teto.json registra o
 * teto vigente do app.js (que começa em 4755 e SÓ PODE DIMINUIR a cada passo —
 * quem extrai um módulo atualiza o teto no MESMO commit). No fim da obra
 * (passo 11) o JSON é apagado e vale o teto universal de 300.
 *
 * Uso: node scripts/checar-tamanho.cjs   (ou: npm run checar-tamanho)
 * Sai com código 1 se qualquer arquivo estourar o teto.
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(RAIZ, 'parceiro', 'public');
const TETO_UNIVERSAL = 300;
const EXCECAO_PATH = path.join(__dirname, 'obra-painel-teto.json');

function contarLinhas(arquivo) {
  // Mesma semântica de `wc -l` / Get-Content .Count: newline final não cria linha extra.
  const texto = fs.readFileSync(arquivo, 'utf8');
  const linhas = texto.split(/\r?\n/);
  if (linhas.length > 0 && linhas[linhas.length - 1] === '') linhas.pop();
  return linhas.length;
}

function lerExcecoes() {
  if (!fs.existsSync(EXCECAO_PATH)) return {};
  try {
    const json = JSON.parse(fs.readFileSync(EXCECAO_PATH, 'utf8'));
    return json.tetos || {};
  } catch (err) {
    console.error(`[FALHA] obra-painel-teto.json ilegível: ${err.message}`);
    process.exit(1);
  }
}

function main() {
  const excecoes = lerExcecoes();
  const arquivos = fs
    .readdirSync(PUBLIC_DIR)
    .filter((f) => /^app(\.[\w-]+)*\.js$/.test(f)) // * = segmentos compostos (app.charts.resumo.js)
    .sort();

  if (arquivos.length === 0) {
    console.error(`[FALHA] nenhum app*.js encontrado em ${PUBLIC_DIR}`);
    process.exit(1);
  }

  let estourou = false;
  for (const nome of arquivos) {
    const linhas = contarLinhas(path.join(PUBLIC_DIR, nome));
    const teto = Object.prototype.hasOwnProperty.call(excecoes, nome) ? excecoes[nome] : TETO_UNIVERSAL;
    const ok = linhas <= teto;
    if (!ok) estourou = true;
    const aviso = teto !== TETO_UNIVERSAL ? ` (teto TEMPORARIO da obra: ${teto})` : '';
    console.log(`${ok ? '[OK]   ' : '[FALHA]'} ${nome}: ${linhas} linhas${aviso}`);
  }

  if (estourou) {
    console.error('\n[FALHA] arquivo acima do teto. Refatore antes de commitar (regra do plano, secao 3).');
    process.exit(1);
  }
  console.log('\n[OK] fiscal de tamanho: todos os arquivos dentro do teto.');
}

main();
