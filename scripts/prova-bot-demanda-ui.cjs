// Interface real e módulos reais, com respostas locais fictícias. Sem banco ou serviços externos.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), pub = path.join(root, 'painel/public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const headerStart = html.indexOf('<section aria-labelledby="bot-heading"');
const headerEnd = html.indexOf('<section x-show="botTab === \'entrega\'"', headerStart);
const demandStart = html.indexOf('<!-- MAPA por município -->'), demandEnd = html.indexOf('<!-- ═══ TELA: CLIENTES', demandStart);
assert(headerStart > 0 && headerEnd > headerStart && demandEnd > demandStart);
const section = html.slice(demandStart, demandEnd).replace(/<\/div>\s*$/, '');
const mapa = [['São Gonçalo',82,24,19,9],['Maricá',54,17,13,7],['Niterói',43,15,12,4]]
  .map(([municipio,chamou,pediu,efetivou,faltou]) => ({municipio,chamou,pediu,efetivou,faltou}));
const sizes = [['130/70-13',28,24],['90/90-12',24,0],['110/70-17',18,16],['180/55-17',12,null]]
  .map(([medida,consultas,galpao_qty]) => ({municipio:'São Gonçalo',medida,consultas,galpao_qty}));
let mode = 'normal';
const payload = period => ({
  demanda_disponivel:true, mapa:mode === 'empty' ? [] : period === 'today' ? [mapa[1]] : mapa,
  sem_regiao:mode === 'empty' ? 0 : 14, cards:null, radar:[], medidas_top:[],
  medidas_por_municipio:mode === 'partial' ? null : mode === 'empty' ? [] : [
    ...sizes,{municipio:'Maricá',medida:'130/70-13',consultas:18,galpao_qty:24},
  ],
});
const boot = `window.demandTest=()=>{
 const state={currentPage:'bot',botTab:'demanda',botCamada:'chamou',botPeriodo:'7d',botLoading:false,
 botVisao:null,botMapaSel:null,adminUser:{role:'owner'},adminAuthenticated:true,
 redePeriods:[{id:'today',label:'Hoje'},{id:'7d',label:'7 dias'},{id:'30d',label:'30 dias'}],
 ensureCredentials(){},async apiGet(url){const response=await fetch(url);if(!response.ok)throw new Error('offline');return response.json();}};
 for(const factory of [PAINEL_MODULES.bot,PAINEL_MODULES.botMapa])Object.defineProperties(state,Object.getOwnPropertyDescriptors(factory()));
 return state;};`;
const pageHtml = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/admin/painel/tailwind.css"><link rel="stylesheet" href="/admin/painel/bot-demanda.css">
<style>body{margin:0;background:#f8faf9;font-family:Arial,sans-serif}.proof-side{position:fixed;inset:0 auto 0 0;width:190px;background:#064b40;color:white;padding:26px 22px}.proof-side b{font-size:40px}.proof-side p{margin:30px 0}.proof-main{margin-left:190px;padding:22px}.proof-tag{font-size:10px;color:#876111;margin-bottom:10px}[x-cloak]{display:none!important}@media(max-width:650px){.proof-side{display:none}.proof-main{margin:0;padding:14px}}</style>
<script src="/admin/painel/app.bot.js"></script><script src="/admin/painel/app.bot.mapa.js"></script><script src="/admin/painel/mapa-rm-dados.js"></script><script src="/admin/painel/vendor/lucide-1.17.0.min.js"></script><script>${boot}</script><script defer src="/admin/painel/vendor/alpine-3.14.9.min.js"></script></head>
<body><aside class="proof-side"><b>2W</b><div>P N E U S</div><p>Visão geral</p><p>● Bot</p><p>Vendas</p><p>Compras</p><p>Estoque</p><p>Logística</p><p>Rede</p><p>Financeiro</p></aside><main class="proof-main bot-demand-page" x-data="demandTest()" x-init="loadBotVisao()"><div class="proof-tag">VALIDAÇÃO LOCAL · DADOS FICTÍCIOS</div>${html.slice(headerStart,headerEnd)}${section}</main></body></html>`;
const allowed = new Set(['tailwind.css','bot-demanda.css','app.bot.js','app.bot.mapa.js','mapa-rm-dados.js','vendor/lucide-1.17.0.min.js','vendor/alpine-3.14.9.min.js','assets/bot-hero.webp']);
const server = http.createServer((req,res) => {
  const url = new URL(req.url,'http://localhost');
  if(url.pathname === '/admin/painel'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(pageHtml);}
  if(url.pathname.startsWith('/admin/api/')){
    res.setHeader('Content-Type','application/json');
    if(url.pathname.endsWith('/visao')){
      if(mode === 'error'){res.statusCode=503;return res.end('{}');}
      return res.end(JSON.stringify(payload(url.searchParams.get('period'))));
    }
    return res.end('{}');
  }
  const name = url.pathname.replace('/admin/painel/','');
  if(!allowed.has(name)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',name.endsWith('.css')?'text/css':name.endsWith('.js')?'application/javascript':'image/webp');
  res.end(fs.readFileSync(path.join(pub,name)));
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL || 'msedge'});
  try{
    const page=await browser.newPage({viewport:{width:1540,height:1050}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port+'/admin/painel');
    await page.locator('.bot-demand-sizes tbody tr').first().waitFor();
    assert.equal(await page.locator('.bot-demand-sizes tbody tr').count(),4);
    assert.equal(await page.getByLabel('Município da demanda').inputValue(),'São Gonçalo');
    assert.equal(await page.locator('.bot-demand-conversion strong').innerText(),'29,3%');
    assert.equal(await page.locator('.bot-demand-summary strong').first().innerText(),'193');
    assert.equal(await page.locator('.bot-demand-stock.is-zero').count(),1);
    assert.equal(await page.locator('.bot-demand-stock.is-unknown').innerText(),'Sem registro');
    const originalView=await page.locator('#bot-mapa svg').getAttribute('viewBox');
    await page.getByRole('button',{name:'Ampliar mapa',exact:true}).click();
    assert.notEqual(await page.locator('#bot-mapa svg').getAttribute('viewBox'),originalView);
    await page.getByRole('button',{name:'Restaurar mapa',exact:true}).click();
    assert.equal(await page.locator('#bot-mapa svg').getAttribute('viewBox'),originalView);
    await page.getByRole('button',{name:'Faltas',exact:true}).click();
    assert.equal(await page.getByLabel('Município da demanda').inputValue(),'São Gonçalo');
    await page.locator('.bot-demand-shortage').waitFor();
    await page.getByLabel('Município da demanda').selectOption('Maricá');
    await page.waitForFunction(()=>document.querySelectorAll('.bot-demand-sizes tbody tr').length===1);
    assert.equal(await page.locator('.bot-demand-sizes tbody tr').innerText().then(t=>t.includes('18')),true);
    assert.equal(await page.locator('[data-municipio="Maricá"]').getAttribute('aria-pressed'),'true');
    await page.locator('[data-municipio="Niterói"]').focus();await page.keyboard.press('Enter');
    await page.getByText('Nenhuma medida consultada neste município no período.',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Município da demanda').inputValue(),'Niterói');
    await page.getByLabel('Município da demanda').selectOption('São Gonçalo');
    await page.getByRole('button',{name:'Procura',exact:true}).click();
    const output=path.join(root,'artifacts','bot-demanda');fs.mkdirSync(output,{recursive:true});
    await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'Não pode haver rolagem horizontal da página');
    await page.getByRole('group',{name:'Período da demanda',exact:true}).getByRole('button',{name:'Hoje',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.bot-demand-city-select select').value==='Maricá');
    assert.equal(await page.locator('.bot-demand-sizes tbody tr').count(),1);
    mode='error';
    await page.getByRole('group',{name:'Período da demanda',exact:true}).getByRole('button',{name:'30 dias',exact:true}).click();
    await page.getByText('Não foi possível carregar a demanda.',{exact:true}).waitFor();
    assert.equal(await page.locator('.bot-demand-summary strong').first().innerText(),'—');
    assert.equal(await page.locator('.bot-demand-layout').isVisible(),false);
    mode='empty';
    await page.getByRole('button',{name:'Tentar novamente',exact:true}).filter({visible:true}).click();
    await page.getByText('Nenhuma conversa registrada neste período.',{exact:true}).waitFor();
    mode='partial';
    await page.getByRole('group',{name:'Período da demanda',exact:true}).getByRole('button',{name:'7 dias',exact:true}).click();
    await page.getByText('As medidas estão indisponíveis no momento.',{exact:false}).waitFor();
    mode='normal';
    await page.getByRole('button',{name:'Tentar novamente',exact:true}).filter({visible:true}).click();
    await page.locator('.bot-demand-sizes tbody tr').first().waitFor();
    await page.getByRole('navigation',{name:'Seções do Bot'}).getByRole('button',{name:'Visão geral',exact:true}).click();
    await page.locator('#bot-heading').waitFor();
    assert.equal(await page.locator('#bot-demand-heading').isVisible(),false);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({ok:true,checks:'cidade, camada, teclado, zoom, período, estoque zero/ausente, vazio, falha, recuperação, outra aba e mobile',screenshots:output,errors}));
  }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
