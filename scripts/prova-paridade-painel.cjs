#!/usr/bin/env node
/**
 * PROVA DE PARIDADE — painel do parceiro (obra PLANO_REFATORACAO_PAINEL_300_2026-06-10.md).
 *
 * O QUE PROVA: a "impressao digital" da interface do parceiroApp() — o nome e o
 * TIPO de cada propriedade do objeto que o Alpine monta (getter | function |
 * value:<tipo>). O index.html chama esses nomes (@click, x-model, x-show); se a
 * refatoracao derrubar/renomear/mudar o tipo de UM que seja, esta prova REPROVA.
 *
 * COMO: mocka o browser (location/localStorage/window/document), carrega os
 * app*.js NA ORDEM DO index.html dentro de um vm isolado, chama parceiroApp()
 * e extrai getOwnPropertyDescriptors. getters NAO sao executados (descriptor
 * nao dispara get) — a tela reativa continua intacta.
 *
 * USO:
 *   node scripts/prova-paridade-painel.cjs                    -> compara com o baseline (exit 1 se diferente)
 *   node scripts/prova-paridade-painel.cjs --gravar-baseline  -> (re)grava scripts/baseline-paridade-painel.json
 *   node scripts/prova-paridade-painel.cjs --dir <pasta>      -> usa outra pasta public (auto-teste/sabotagem)
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RAIZ = path.join(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'baseline-paridade-painel.json');

function args() {
  const a = process.argv.slice(2);
  const dirIdx = a.indexOf('--dir');
  return {
    gravar: a.includes('--gravar-baseline'),
    dir: dirIdx >= 0 ? path.resolve(a[dirIdx + 1]) : path.join(RAIZ, 'parceiro', 'public'),
  };
}

/** Ordem REAL de carga: os <script src="./app*.js"> do index.html, na ordem. */
function listarScriptsDoIndex(publicDir) {
  const indexPath = path.join(publicDir, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  const re = /<script[^>]+src="\.\/(app[^"?]*\.js)(?:\?[^"]*)?"/g;
  const arquivos = [];
  let m;
  while ((m = re.exec(html))) arquivos.push(m[1]);
  if (arquivos.length === 0) {
    throw new Error(`nenhum <script src="./app*.js"> achado em ${indexPath} — regex quebrou ou HTML mudou`);
  }
  return arquivos;
}

/** Browser de mentira: o minimo pro top-level + corpo do parceiroApp() avaliarem. */
function criarSandbox() {
  const storage = {
    _dados: Object.create(null),
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._dados, k) ? this._dados[k] : null; },
    setItem(k, v) { this._dados[k] = String(v); },
    removeItem(k) { delete this._dados[k]; },
    clear() { this._dados = Object.create(null); },
  };
  const elementoFake = () => ({
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, appendChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, click() {},
    getContext() { return null; },
  });
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    Date, Math, JSON, Intl, URL, URLSearchParams, Promise, Error, TypeError, RangeError,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, parseFloat, parseInt,
    isNaN, isFinite, structuredClone, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    location: {
      pathname: '/parceiro/zz-teste-copacabana/',
      href: 'http://localhost:4101/parceiro/zz-teste-copacabana/',
      origin: 'http://localhost:4101', search: '', hash: '', reload() {},
    },
    localStorage: storage,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'prova-paridade-painel', language: 'pt-BR', clipboard: { writeText: () => Promise.resolve() } },
    document: {
      addEventListener() {}, removeEventListener() {}, createElement: elementoFake,
      getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
      body: elementoFake(), documentElement: elementoFake(), head: elementoFake(),
      hidden: false, title: 'prova', visibilityState: 'visible',
    },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
    EventSource: Object.assign(function EventSourceFake() {
      return { close() {}, addEventListener() {}, readyState: 0 };
    }, { CONNECTING: 0, OPEN: 1, CLOSED: 2 }),
    WebSocket: function WebSocketFake() { return { close() {}, addEventListener() {} }; },
    FormData: function FormDataFake() { return { append() {} }; },
    Audio: function AudioFake() { return { play: () => Promise.resolve(), pause() {} }; },
    AudioContext: function AudioContextFake() { return { createOscillator: () => ({ connect() {}, start() {}, stop() {}, frequency: {} }), createGain: () => ({ connect() {}, gain: {} }), destination: {}, currentTime: 0 }; },
    Image: function ImageFake() { return {}; },
    FileReader: function FileReaderFake() { return { readAsDataURL() {}, addEventListener() {} }; },
    Notification: Object.assign(function NotificationFake() {}, { permission: 'denied', requestPermission: () => Promise.resolve('denied') }),
    Chart: Object.assign(function ChartFake() { return { destroy() {}, update() {}, resize() {} }; }, { defaults: { color: '', font: {} } }),
    lucide: { createIcons() {} },
    Alpine: { store() {}, data() {}, start() {} },
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    addEventListener() {}, removeEventListener() {}, open() {}, alert() {}, confirm() { return false; },
    scrollTo() {}, getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

function tipoDe(desc) {
  if (desc.get && desc.set) return 'getter+setter';
  if (desc.get) return 'getter';
  if (desc.set) return 'setter';
  const v = desc.value;
  if (typeof v === 'function') return 'function';
  if (v === null) return 'value:null';
  if (Array.isArray(v)) return 'value:array';
  return `value:${typeof v}`;
}

function gerarManifesto(publicDir) {
  const arquivos = listarScriptsDoIndex(publicDir);
  const ctx = vm.createContext(criarSandbox());
  for (const nome of arquivos) {
    const codigo = fs.readFileSync(path.join(publicDir, nome), 'utf8');
    vm.runInContext(codigo, ctx, { filename: nome });
  }
  const app = vm.runInContext('parceiroApp()', ctx);
  if (!app || typeof app !== 'object') throw new Error('parceiroApp() nao devolveu objeto');
  const descs = Object.getOwnPropertyDescriptors(app);
  const propriedades = {};
  for (const nome of Object.keys(descs).sort()) propriedades[nome] = tipoDe(descs[nome]);
  return { arquivos, propriedades };
}

function resumo(propriedades) {
  const porTipo = {};
  for (const t of Object.values(propriedades)) porTipo[t] = (porTipo[t] || 0) + 1;
  return Object.entries(porTipo).sort().map(([t, n]) => `${t}=${n}`).join('  ');
}

function main() {
  const { gravar, dir } = args();
  const { arquivos, propriedades } = gerarManifesto(dir);
  const total = Object.keys(propriedades).length;
  console.log(`[info] ordem de carga (index.html): ${arquivos.join(' -> ')}`);
  console.log(`[info] ${total} propriedades no objeto do Alpine (${resumo(propriedades)})`);

  if (gravar) {
    const baseline = { geradoEm: new Date().toISOString(), commitBase: 'c0d7913', total, propriedades };
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`[OK] baseline gravado em ${path.relative(RAIZ, BASELINE_PATH)} (${total} propriedades)`);
    return;
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.error('[FALHA] baseline nao existe. Gere com --gravar-baseline (so no passo 0!).');
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const antes = baseline.propriedades;
  const sumiram = Object.keys(antes).filter((k) => !(k in propriedades));
  const surgiram = Object.keys(propriedades).filter((k) => !(k in antes));
  const mudaram = Object.keys(antes).filter((k) => k in propriedades && antes[k] !== propriedades[k]);

  if (sumiram.length === 0 && surgiram.length === 0 && mudaram.length === 0) {
    console.log(`[OK] PARIDADE: manifesto identico ao baseline (${total} propriedades).`);
    return;
  }
  for (const k of sumiram) console.error(`[FALHA] SUMIU:           ${k} (era ${antes[k]})`);
  for (const k of surgiram) console.error(`[FALHA] APARECEU:        ${k} (${propriedades[k]}) — refatoracao nao cria nome novo`);
  for (const k of mudaram) console.error(`[FALHA] MUDOU DE TIPO:   ${k} (${antes[k]} -> ${propriedades[k]})`);
  console.error(`\n[FALHA] PARIDADE QUEBROU: ${sumiram.length} sumiram, ${surgiram.length} apareceram, ${mudaram.length} mudaram. Passo REPROVADO (plano, secao 4 item 2).`);
  process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(`[FALHA] prova de paridade nao rodou: ${err.message}`);
  process.exit(1);
}
