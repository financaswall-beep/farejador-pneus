// HTML e módulo reais, respostas fictícias locais; não acessa conversas nem bancos reais.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const pub=path.resolve(__dirname,'../painel/public'),html=fs.readFileSync(path.join(pub,'index.html'),'utf8');
const header=html.match(/<header x-show="botTab === 'faltas'"[\s\S]*?<\/header>/)?.[0];assert(header);
const navStart=html.indexOf('      <div class="bot-section-navigation'),navEnd=html.indexOf('      <section x-show="botTab === \'espera\'"',navStart);assert(navStart>0&&navEnd>navStart);
const navigation=html.slice(navStart,navEnd),hostTag=html.match(/<div x-show="currentPage === 'bot'"[^>]+>/)?.[0];assert(hostTag);
const body=html.slice(html.indexOf('<!-- RELATÓRIO DE FALTAS:'),html.indexOf('<!-- MAPA por município -->'));
const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
const counts=[['matriz','Matriz','90/90-12',12],[a,'Parceiro Alcântara','90/90-12',8],['matriz','Matriz','180/55-17',5],[b,'Parceiro Fonseca','180/55-17',5],['ita','Parceiro Itaipuaçu','130/70-13',7],['centro','Parceiro Centro','110/70-17',4]]
 .map(([store_id,store_name,measure,shortages])=>({store_id,store_name,measure,shortages}));
let mode='normal';
const summary=()=>({consultations:32,shortages:41,store_count:5,measure_count:4,counts:mode==='empty'?[]:counts,legacy_records:0,tracking_since:'2026-09-10T12:00:00Z'});
const pageHtml=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/admin/painel/tailwind.css"><link rel="stylesheet" href="/admin/painel/bot-entrega.css"><link rel="stylesheet" href="/admin/painel/bot-faltas.css">
<style>body{margin:0;font-family:Arial,sans-serif;background:#f7faf9}.side{position:fixed;inset:0 auto 0 0;width:190px;padding:26px;background:#004c40;color:white}.side b{font-size:40px}.side p{margin-top:30px}main{margin-left:190px;padding:0}.proof-top{height:84px;padding:12px;background:#f9fafb}.proof-top>div{height:60px;border-radius:12px;padding:17px;background:#023b2e;color:#fff}.proof-top strong{margin-right:45px}.proof-label{display:block;margin:0 0 12px;font-size:10px;color:#72572c}[x-cloak]{display:none!important}@media(max-width:650px){.side{display:none}main{margin:0;padding:0}.proof-top{display:none}}</style>
<script src="/admin/painel/app.bot.faltas.js"></script><script>window.proof=()=>{const s={currentPage:'bot',botTab:'faltas',botEntregaAbrir(){this.botTab='entrega'},renderBotMapa(){},openedConversation:null,abrirNoChatwoot(id){this.openedConversation=id},adminUser:{role:'owner'},redePeriods:[],botPeriodo:'7d',apiHeaders:()=>({}),chatwootConvUrl:id=>id?'https://example.invalid/'+id:null,async apiGet(u){const r=await fetch(u);if(!r.ok)throw Error('offline');return r.json()}};Object.defineProperties(s,Object.getOwnPropertyDescriptors(PAINEL_MODULES.botFaltas()));return s}</script><script src="/admin/painel/vendor/lucide-1.17.0.min.js"></script><script defer src="/admin/painel/vendor/alpine-3.14.9.min.js"></script></head><body><aside class="side"><b>2W</b><div>P N E U S</div><p>Visão geral</p><p>● Bot</p><p>Vendas</p><p>Compras</p><p>Estoque</p><p>Logística</p><p>Rede</p><p>Financeiro</p></aside><main x-data="proof()" x-init="bfOpen(); lucide.createIcons()"><div class="proof-top"><div><strong>CENTRAL DE REDE</strong>Buscar parceiro, pedido, produto…</div></div>${hostTag}<small class="proof-label">VALIDAÇÃO LOCAL · DADOS FICTÍCIOS</small>${header}${navigation}${body}</div></main></body></html>`;
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/admin/painel'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(pageHtml);}
 if(url.pathname.startsWith('/admin/api/bot/faltas')){
  if(mode==='error'||(mode==='detailError'&&url.pathname.endsWith('consultas'))){res.statusCode=503;return res.end('{}');}
  if(url.pathname.endsWith('exportar')){res.setHeader('Content-Type','text/csv');res.setHeader('Content-Disposition','attachment; filename=faltas.csv');return res.end('Medida;Loja\n90/90-12;Parceiro Alcântara');}
  res.setHeader('Content-Type','application/json');
  if(url.pathname.endsWith('consultas')){
   const measure=url.searchParams.get('measure'),offset=Number(url.searchParams.get('offset')||0),store=url.searchParams.get('store');
   const total=store===a?8:25;
   const rows=Array.from({length:Math.min(20,total-offset)},(_,i)=>({id:measure+'-'+(i+offset),measure,searches:i+offset===1?2:i+offset===0?3:1,chatwoot_id:'12345',occurred_at:'2026-09-10T13:'+String(42-i).padStart(2,'0')+':00Z',municipality:i+offset===1?'Niterói':'São Gonçalo',filters:i+offset===1?{marca:'Pirelli',condicao_pneu:'novo',posicao_pneu:'rear'}:{condicao_pneu:'meia_vida'},stores:i+offset===1?[{id:a,name:'Parceiro Alcântara',available:false}]:[{id:a,name:'Parceiro Alcântara',available:false},{id:'matriz',name:'Matriz',available:false}]}));
   const send=()=>res.end(JSON.stringify({rows,total,stock:mode==='unknownStock'?[]:[{store_id:'matriz',quantity:0},{store_id:a,quantity:6}]}));
   if(store===b)return setTimeout(send,250);return send();
  }
  return res.end(JSON.stringify(mode==='empty'?{...summary(),consultations:0,shortages:0,store_count:0,measure_count:0}:summary()));
 }
 const name=url.pathname.replace('/admin/painel/','');
 if(!['tailwind.css','bot-entrega.css','bot-faltas.css','app.bot.faltas.js','vendor/alpine-3.14.9.min.js','vendor/lucide-1.17.0.min.js','assets/fonts/roboto-latin-v1.woff2','assets/fonts/roboto-condensed-latin-v1.woff2'].includes(name)){res.statusCode=404;return res.end();}
 res.setHeader('Content-Type',name.endsWith('.css')?'text/css':name.endsWith('.woff2')?'font/woff2':'application/javascript');res.end(fs.readFileSync(path.join(pub,name)));
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
try{
 const page=await browser.newPage({viewport:{width:1540,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port+'/admin/painel');await page.locator('.bf-measures .bf-row').first().waitFor();
 assert.equal(await page.locator('.bf-measures .bf-row').count(),4);
 const out=path.resolve(__dirname,'../artifacts/bot-faltas');fs.mkdirSync(out,{recursive:true});
 await page.locator('.bf-stock').waitFor();await page.evaluate(()=>document.fonts.ready);
 const layout=await page.evaluate(()=>{const stock=document.querySelector('.bf-stock').getBoundingClientRect(),panels=document.querySelector('.bf-layout').getBoundingClientRect();return{stockBelow:stock.top>=panels.bottom,overflow:document.documentElement.scrollWidth>innerWidth,engraved:getComputedStyle(document.querySelector('.bf-bar')).boxShadow.includes('inset'),innerStock:!!document.querySelector('.bf-detail .bf-current')}});
 assert.equal(layout.stockBelow,true);assert.equal(layout.overflow,false);assert.equal(layout.engraved,true);assert.equal(layout.innerStock,false);
 assert.equal(await page.getByRole('navigation',{name:'Seções do Bot'}).getByRole('button',{name:'Faltas por loja',exact:true}).getAttribute('aria-current'),'page');
 assert.equal(await page.locator('.bf-measure-store').count(),2);assert.match(await page.locator('.bf-measure-store').first().innerText(),/Matriz\s+12 faltas/);assert.match(await page.locator('.bf-measure-store').last().innerText(),/Parceiro Alcântara\s+8 faltas/);
 assert.match(await page.locator('.bf-search-meta').innerText(),/3 buscas nesta conversa/);assert.match(await page.locator('.bf-search-meta').innerText(),/2 lojas consultadas/);assert.match(await page.locator('.bf-search-filters').innerText(),/meia vida/);
 await page.locator('.bf-consultation').nth(1).click();await page.waitForFunction(()=>Alpine.$data(document.querySelector('main')).bf.selected?.municipality==='Niterói');
 assert.match(await page.locator('.bf-search-meta').innerText(),/2 buscas nesta conversa/);assert.match(await page.locator('.bf-search-meta').innerText(),/1 loja consultada/);assert.match(await page.locator('.bf-search-filters').innerText(),/Pirelli · novo · traseiro/);
 assert.equal(await page.locator('.bf-step').count(),1);assert.equal(await page.locator('.bf-measure-store').count(),2,'Totais do período independem da consulta escolhida');
 await page.locator('.bf-consultation').first().click();await page.waitForFunction(()=>Alpine.$data(document.querySelector('main')).bf.selected?.municipality==='São Gonçalo');
 await page.screenshot({path:path.join(out,'desktop-visao-geral.png'),fullPage:true});
 const boardClip=await page.locator('.bf-detail').evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.left-8,y:r.top+scrollY-35,width:r.width+16,height:r.height+45}});
 await page.screenshot({path:path.join(out,'prancheta.png'),fullPage:true,clip:boardClip});
 await page.locator('.bf-measures .bf-row').nth(1).click();await page.waitForFunction(()=>Alpine.$data(document.querySelector('main')).bf.measure==='180/55-17'&&!Alpine.$data(document.querySelector('main')).bf.detailLoading);
 assert.equal(await page.locator('.bf-measures .bf-row[aria-pressed=true]').count(),1);assert.match(await page.locator('.bf-detail-title').innerText(),/180\/55-17/);assert.match(await page.locator('.bf-measure-stores').innerText(),/Parceiro Fonseca/);assert.doesNotMatch(await page.locator('.bf-measure-stores').innerText(),/Alcântara/);
 await page.locator('.bf-measures .bf-row').first().focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>Alpine.$data(document.querySelector('main')).bf.measure==='90/90-12'&&!Alpine.$data(document.querySelector('main')).bf.detailLoading);
 assert.equal(await page.locator('.bf-measures .bf-row').first().getAttribute('aria-pressed'),'true');
 await page.locator('.bf-measures').screenshot({path:path.join(out,'medida-selecionada.png')});
 await page.getByRole('button',{name:'Ver conversa ↗',exact:true}).click();assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).openedConversation),'12345');
 mode='unknownStock';await page.locator('.bf-measures .bf-row').first().click();await page.getByText('Sem registro',{exact:true}).first().waitFor();assert(!/Zerado/.test(await page.locator('.bf-current').innerText()));
 mode='normal';await page.locator('.bf-measures .bf-row').first().click();await page.getByText('6 un',{exact:true}).waitFor();
 await page.locator('.bf-shops .bf-row').filter({hasText:'Parceiro Alcântara'}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.bf-measures .bf-row').length===1&&!Alpine.$data(document.querySelector('main')).bf.detailLoading);
 assert.match(await page.locator('.bf-measures .bf-row').innerText(),/8 faltas/);assert.equal(await page.locator('.bf-step').count(),2);assert.equal(await page.locator('.bf-measure-store').count(),1);assert.match(await page.locator('.bf-measure-stores').innerText(),/Parceiro Alcântara\s+8 faltas/);assert.match(await page.locator('.bf-detail-title').innerText(),/8 faltas nesta loja/);
 assert.match(await page.locator('.bf-current').innerText(),/6 un/);assert.equal(await page.locator('.bf-consultation').count(),3);
 assert.match(await page.locator('.bf-summary').innerText(),/Conversas com falta/);
 assert.match(await page.locator('.bf-consultation').first().innerText(),/3 buscas nesta conversa/);
 await page.screenshot({path:path.join(out,'desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'Ver histórico completo →'}).click();assert.equal(await page.locator('.bf-consultation').count(),8);await page.locator('.bf-consultation').nth(3).click();await page.waitForFunction(()=>Alpine.$data(document.querySelector('main')).bf.selected?.searches===1);assert.match(await page.locator('.bf-search-meta').innerText(),/1 busca nesta conversa/);
 await page.getByLabel('Buscar medida nas faltas').fill('180/55-17');await page.waitForFunction(()=>document.querySelectorAll('.bf-measures .bf-row').length===0);
 await page.getByLabel('Remover filtro de loja').click();await page.waitForFunction(()=>document.querySelectorAll('.bf-measures .bf-row').length===1);
 assert.match(await page.locator('.bf-detail-title').innerText(),/180\/55-17/);
 await page.getByLabel('Buscar medida nas faltas').fill('');await page.waitForFunction(()=>document.querySelectorAll('.bf-measures .bf-row').length===4);
 await page.locator('.bf-shops .bf-row').filter({hasText:'Parceiro Fonseca'}).click();await page.locator('.bf-shops .bf-row').filter({hasText:'Parceiro Alcântara'}).click();
 await page.waitForTimeout(350);assert.match(await page.locator('.bf-detail-title').innerText(),/90\/90-12/);
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Exportar relatório',exact:true}).click();assert.match((await download).suggestedFilename(),/^faltas-/);
 await page.getByRole('button',{name:'Personalizado',exact:true}).click();await page.getByLabel('Início das faltas').fill('2026-09-10');await page.getByLabel('Fim das faltas').fill('2026-09-01');
 await page.getByRole('button',{name:'Aplicar período'}).click();await page.getByText('Selecione um período válido',{exact:false}).waitFor();
 mode='error';await page.getByRole('button',{name:'Mês',exact:true}).click();await page.getByText('Não foi possível carregar as faltas.',{exact:false}).waitFor();
 mode='empty';await page.getByRole('button',{name:'Tentar novamente',exact:true}).first().click();await page.getByText('As lojas aparecerão conforme as buscas registrarem faltas.').waitFor();assert.equal(await page.locator('.bf-measure-panel').isVisible(),false);
 mode='normal';await page.getByRole('button',{name:'Semana',exact:true}).click();await page.locator('.bf-measures .bf-row').first().waitFor();
 mode='detailError';await page.locator('.bf-shops .bf-row').filter({hasText:'Parceiro Alcântara'}).click();await page.getByText('Não foi possível carregar estas consultas.').waitFor();
 mode='normal';await page.getByRole('button',{name:'Tentar novamente',exact:true}).last().click();await page.locator('.bf-step').first().waitFor();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Sem overflow no celular');assert.deepEqual(errors,[]);process.stdout.write('PASS: loja, medida, sequência, filtros, concorrência, CSV, link de conversa, estoque desconhecido, card separado, gráficos entalhados, distribuição da medida, resumo histórico, teclado, erro, vazio e celular.\n');
}finally{await browser.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
