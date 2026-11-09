// Exercita o HTML/Alpine real com dados fictícios locais. Nenhuma requisição à produção.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const pub = path.resolve(__dirname, '../painel/public'), out = path.resolve(process.env.PROOF_OUTPUT || '.codex-tmp/transfer-proof');
const source = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const start = source.indexOf('    <section x-show="currentPage===\'estoque\' && isMatrixPanel() && st.historyOpen"');
const end = source.indexOf('    <template x-if="currentPage === \'estoque\' && isMatrixPanel() && stockTab === \'custos\'">', start);
assert(start > 0 && end > start, 'HTML das transferências ausente');
const lot = { id: 'lot-proof', lot_code: 'LT-000001', description: 'Lote de 200 pneus', quantity_on_hand: 200, available_quantity: 200 };
const products = [{ id: 'p1', measure: '130/70-13', brand: 'Pirelli', tire_condition: 'meia_vida', vehicle_type: 'motorcycle' }];
const pageHtml = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/admin/painel/estoque-lotes.css"><style>body{margin:0;font:14px Arial;background:#f5f8f7}[x-cloak]{display:none!important}main>nav{padding:24px;display:flex;flex-wrap:wrap;gap:12px}</style><script src="/admin/painel/app.estoque.transferencias.js"></script>
<script>window.proof=()=>({...PAINEL_MODULES.estoqueTransferencias(),serverEnvironment:'test',adminUser:{id:'proof',role:'owner'},currentPage:'estoque',
 isMatrixPanel:()=>true,hasPanelModule:()=>true,tireLots:{sources:[{id:'s1',measure:'130/70-13',brand:'Pirelli',tire_condition:'meia_vida',available_quantity:20}],sourceSearch:''},
 tireLotSourcesLoad:async()=>{},tireLotsLoad:async()=>{},tireLotsLoadMovements:async()=>{},loadAtacado:async()=>{},formatCurrency:v=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v),tireLotDate:()=> '09 nov.',
 apiGet:async u=>{const r=await fetch(u);if(!r.ok)throw Error('failed');return r.json()},apiPost:async(u,b)=>{const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const d=await r.json();if(!r.ok)throw Error(d.error);return d}})</script><script defer src="/admin/painel/vendor/alpine-3.14.9.min.js"></script></head>
<body><main x-data="proof()"><nav><button class="tl-btn" @click='stOpen("to_stock",${JSON.stringify(lot)})'>Desmembrar</button><button class="tl-btn" @click='stOpen("loss",${JSON.stringify(lot)})'>Perda</button><button class="tl-btn" @click='stOpen("to_lot")'>Formar lote</button><button class="tl-btn" @click="stHistory()">Histórico</button></nav>${source.slice(start,end)}</main></body></html>`;
let confirmed = 0;
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end(pageHtml); }
  if (u.pathname.startsWith('/admin/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify(u.pathname.endsWith('stock-transfer-products') ? { rows: products } : { rows: [], total: 0 }));
    let text = ''; for await (const part of req) text += part; const body = JSON.parse(text);
    if (u.pathname.endsWith('/preview')) {
      const loss = body.kind === 'loss', qty = body.quantity || body.items[0].quantity;
      return res.end(JSON.stringify({ input: body, fingerprint: 'a'.repeat(64), lot: body.kind === 'to_lot' ? null : lot,
        quantity: qty, cost: (qty * 5).toFixed(2), remaining_quantity: body.kind === 'to_lot' ? qty : 200 - qty,
        items: loss ? [] : [{ before: { quantity_on_hand: body.kind === 'to_lot' ? 20 : 5 }, after: { ...products[0], quantity_on_hand: body.kind === 'to_lot' ? 20 - qty : 5 + qty, unit_cost: 5 } }] }));
    }
    confirmed++; return res.end(JSON.stringify({ id: 'confirmed-transfer' }));
  }
  const file = path.resolve(pub, u.pathname.replace('/admin/painel/', ''));
  if (!file.startsWith(pub + path.sep) || !fs.existsSync(file) || !/\.(js|css)$/.test(file)) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(fs.readFileSync(file));
});
(async () => {
  fs.mkdirSync(out, { recursive: true }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:' + server.address().port); await page.getByRole('button', { name: 'Desmembrar', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.getByLabel('Produto de destino').selectOption('p1');
    await dialog.getByLabel('Quantidade', { exact: true }).fill('20'); await dialog.getByLabel('Motivo').fill('Pneus identificados na triagem');
    await dialog.getByRole('button', { name: 'Conferir saldos e custos' }).click(); await dialog.getByText('Conferência antes de confirmar').waitFor();
    assert.match(await dialog.innerText(), /200 → 180/); assert.equal(confirmed, 0);
    await dialog.getByRole('button', { name: 'Confirmar movimentação', exact: true }).focus();
    await page.keyboard.press('Tab'); assert(await dialog.getByRole('button', { name: 'Fechar transferência' }).evaluate(el => el === document.activeElement));
    await page.keyboard.press('Shift+Tab'); assert(await dialog.getByRole('button', { name: 'Confirmar movimentação', exact: true }).evaluate(el => el === document.activeElement));
    await page.screenshot({ path: path.join(out, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(out, 'mobile.png'), fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'overflow horizontal');
    await dialog.getByRole('button', { name: 'Confirmar movimentação', exact: true }).click(); await dialog.waitFor({ state: 'detached' }); assert.equal(confirmed, 1);
    await page.getByRole('button', { name: 'Perda', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Quantidade', { exact: true }).fill('2'); await page.getByRole('dialog').getByLabel('Motivo').fill('Pneus inutilizáveis');
    await page.getByRole('dialog').getByRole('button', { name: 'Conferir saldos e custos' }).click();
    await page.getByRole('dialog').getByText('Conferência antes de confirmar').waitFor();
    assert.match(await page.getByRole('dialog').innerText(), /impacto no resultado/); assert.equal(confirmed, 1);
    await page.screenshot({ path: path.join(out, 'perda.png'), fullPage: true });
    await page.getByRole('button', { name: 'Fechar transferência', exact: true }).click();
    await page.getByRole('button', { name: 'Formar lote', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Variante de origem').selectOption('s1');
    await page.getByRole('dialog').getByLabel('Nome do lote').fill('Lote para borracharia');
    await page.getByRole('dialog').getByLabel('Quantidade', { exact: true }).fill('3'); await page.getByRole('dialog').getByLabel('Motivo').fill('Agrupar para venda no atacado');
    await page.getByRole('dialog').getByRole('button', { name: 'Conferir saldos e custos' }).click(); await page.getByRole('dialog').getByText('Conferência antes de confirmar').waitFor();
    assert.match(await page.getByRole('dialog').innerText(), /20 → 17/); assert.equal(confirmed, 1);
    assert.deepEqual(errors, []); console.log('OK: desmembramento, perda e formação de lote; prévia sem escrita; confirmação única; desktop e mobile sem overflow.');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
