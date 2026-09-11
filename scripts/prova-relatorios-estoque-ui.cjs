// Validação da tela real com dados fictícios locais. Nenhuma conexão com produção.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
Object.assign(process.env,{FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test:test@127.0.0.1:1/test',CHATWOOT_HMAC_SECRET:'proof',ADMIN_AUTH_TOKEN:'proof'});
const root=path.resolve(__dirname,'..'),pub=path.join(root,'painel/public'),out=path.join(root,'artifacts/relatorios-estoque');fs.mkdirSync(out,{recursive:true});
const html=fs.readFileSync(path.join(pub,'index.html'),'utf8'),section=html.slice(html.indexOf('<!-- RELATÓRIOS DA MATRIZ:'),html.indexOf('<!-- ═══ TELA: PLACEHOLDERS'));
const modules=['app.relatorios.financeiro.js','app.relatorios.financeiro.view.js','app.relatorios.financeiro.charts.js','app.relatorios.financeiro.export.js','app.relatorios.financeiro.pdf.js','app.relatorios.pdf.core.js','app.compras.reposicao.js','app.galpao.multibrand.js',...['estoque','compras','logistica'].flatMap(name=>['','.view','.export','.pdf'].map(suffix=>'app.relatorios.'+name+suffix+'.js')),...['','.view','.export','.pdf'].map(suffix=>'app.relatorios'+suffix+'.js')];
const shell=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/admin/painel/tailwind.css"><link rel="stylesheet" href="/admin/painel/relatorios.css"><link rel="stylesheet" href="/admin/painel/relatorios-estoque.css"><style>body{margin:0;font-family:Inter,Arial,sans-serif;background:#f7f9fa}.proof-side{position:fixed;inset:0 auto 0 0;width:190px;background:#00483c;color:white;padding:24px 20px}.proof-side h2{font-size:25px;font-weight:700}.proof-side p{margin-top:28px}main{margin-left:190px}.proof-label{padding:8px 24px;background:#fff7dd;color:#806127;font-size:11px}[x-cloak]{display:none!important}@media(max-width:700px){.proof-side{display:none}main{margin:0}}</style>${modules.map(name=>'<script src="/admin/painel/'+name+'"></script>').join('')}
<script>window.proof=()=>{const s={currentPage:'relatorios',panelWorkplace:{id:'matrix'},adminUser:{username:'proof',role:'owner'},comprasReplenishment:{},isMatrixPanel:()=>true,hasPanelModule:()=>true,apiHeaders:()=>({}),adminUnauthorized(){throw Error('Unauthorized')},bfOpen(){},renderBotMapa(){},async apiGet(u){const r=await fetch(u);if(!r.ok)throw Error('api_'+r.status);return r.json()}};for(const f of Object.values(PAINEL_MODULES))Object.defineProperties(s,Object.getOwnPropertyDescriptors(f()));s.rp.report='estoque';return s}</script><script defer src="/admin/painel/vendor/alpine-3.14.9.min.js"></script></head><body><aside class="proof-side"><h2>Farejador</h2><small>DISTRIBUIÇÃO DE PNEUS</small><p>Resumo</p><p>Bot</p><p>Vendas</p><p>Clientes</p><p>Compras</p><p>Estoque</p><p>Logística</p><p>Financeiro</p><p>Rede</p><p>Catálogo</p><p>▥ Relatórios</p></aside><main x-data="proof()" x-init="rpOpen()"><div class="proof-label">VALIDAÇÃO LOCAL · dados fictícios</div>${section}</main></body></html>`;
(async()=>{
 const imp=name=>import(pathToFileURL(path.join(root,'dist/admin/painel/'+name+'.js')));
 const {buildStockReport}=await imp('queries-stock-report'),{stockReportQuery}=await imp('stock-report-filter'),{stockReportCsv}=await imp('stock-report-csv');
 const {reportAddDays}=await imp('report-period'),today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date()),asOf=new Date().toISOString();
 const variants=[],movements=[];
 const add=(measure,physical,reserved,incoming,minimum,brand='Pirelli',condition='novo')=>variants.push({measure,brand,condition,physical,reserved,incoming,minimum,has_stock:physical>0||incoming===0});
 add('90/90-12',0,0,0,12);add('130/70-13',4,1,0,20);add('130/70-13',1,0,0,20,'Michelin');add('130/70-13',0,0,8,20,'Technic');
 add('180/55-17',2,0,0,6);add('110/70-17',18,0,0,12);add('100/80-17',16,0,0,6);add('140/70-17',6,0,0,null);
 for(let i=0;i<28;i++)add((210+i)+'/50-17',12,0,0,0);
 for(const [i,size] of ['90/90-12','130/70-13','180/55-17','110/70-17'].entries())movements.push({id:'sale-'+i,measure:size,brand:'Pirelli',condition:'novo',at:asOf,before:40,after:40-[18,24,6,12][i],delta:-[18,24,6,12][i],source:'varejo'});
 for(let i=0;i<80;i++)movements.push({id:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),measure:'90/90-12',brand:'Pirelli',condition:'novo',
  at:reportAddDays(today,-i%20)+'T12:00:00Z',before:20,after:i%3?24:18,delta:i%3?4:-2,source:i%3?'compra':'baixa_manual'});
 let mode='normal',otherReports=0,mutations=0;
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');if(req.method!=='GET')mutations++;
  if(url.pathname==='/admin/painel'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(url.searchParams.has('full')?html:shell);}
  if(url.pathname==='/admin/api/auth/me'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({user:{username:'proof',display_name:'Validação local',role:'admin'},workplace:{id:'matrix',kind:'matrix',name:'Matriz',role:'admin'},modules:['estoque']}));}
  if(/\/relatorios\/(vendas|compras)/.test(url.pathname))otherReports++;
  if(url.pathname==='/admin/api/wholesale/suppliers/prices'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({rows:[{measure:'130/70-13',tire_condition:'novo',brand:'Pirelli',supplier_id:'supplier',supplier_name:'Fornecedor local',avg_cost:100,purchases_count:3}]}));}
  if(url.pathname.startsWith('/admin/api/relatorios/estoque')){
   const parsed=stockReportQuery.safeParse(Object.fromEntries(url.searchParams));if(!parsed.success){res.statusCode=400;return res.end('{}');}
   if(mode==='error'){res.statusCode=503;return res.end('{}');}
   const report=buildStockReport({as_of:asOf,from:reportAddDays(today,1-Number(parsed.data.days)),to:today,variants:mode==='empty'?[]:variants,movements:mode==='empty'?[]:movements},parsed.data);
   if(url.pathname.endsWith('exportar')){res.setHeader('Content-Type','text/csv');return res.end(stockReportCsv(report));}
   const {export_movements,...payload}=report;if(url.pathname.endsWith('imprimir'))payload.movements={total:export_movements.length,offset:0,rows:export_movements};
   res.setHeader('Content-Type','application/json');return setTimeout(()=>res.end(JSON.stringify(payload)),parsed.data.days==='60'?180:10);
  }
  if(url.pathname.startsWith('/admin/api/')){res.statusCode=503;return res.end('{"error":"outside_local_proof"}');}
  const name=url.pathname.replace('/admin/painel/',''),file=path.resolve(pub,name),ext=path.extname(file);
  if(!file.startsWith(pub+path.sep)||!['.js','.css','.svg','.webp','.png','.json'].includes(ext)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.json':'application/json'})[ext]);res.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true,channel:'msedge'});
 try{
  const page=await browser.newPage({viewport:{width:1720,height:1150}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const card=page.locator('.rst-report'),settled=()=>page.waitForFunction(()=>window.Alpine&&Alpine.$data(document.querySelector('main')).rst.data&&!Alpine.$data(document.querySelector('main')).rst.loading);
  await page.goto('http://127.0.0.1:'+server.address().port+'/admin/painel');await settled();
  assert.equal(await card.getByRole('tab').count(),4);await card.locator('.rst-stock-table').getByRole('button',{name:'130/70-13',exact:true}).click();
  await card.locator('.rst-total').getByText('8 pneus',{exact:true}).waitFor();await page.screenshot({path:path.join(out,'visao-geral.png'),fullPage:true});
  await card.getByRole('tab',{name:'Produtos',exact:true}).click();await card.getByRole('button',{name:'Próximos',exact:true}).click();assert.equal(await card.locator('.rst-stock-table tbody tr').count(),9);
  await card.getByRole('tab',{name:'Reposição',exact:true}).click();await card.locator('.rst-stock-table').getByRole('button',{name:'130/70-13',exact:true}).waitFor();
  assert.equal(await card.locator('.rst-stock-table tbody tr').count(),3);await page.screenshot({path:path.join(out,'reposicao.png'),fullPage:true});
  await card.getByRole('button',{name:'Ver grupos sem mínimo →'}).click();await settled();assert.equal(await card.locator('.rst-stock-table tbody tr').count(),1);
  await card.locator('.rst-stock-table').getByRole('button',{name:'140/70-17'}).click();await card.getByText('Sem giro para estimar',{exact:true}).waitFor();
  await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();await card.getByRole('tab',{name:'Visão geral',exact:true}).click();
  await card.getByRole('button',{name:'60 dias',exact:true}).click();await card.getByRole('button',{name:'90 dias',exact:true}).click();await settled();await page.waitForTimeout(230);
  assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rst.data.filters.days),'90');
  await card.getByRole('button',{name:'Salvar visão',exact:true}).click();await card.getByRole('button',{name:'30 dias',exact:true}).click();await settled();
  await card.getByRole('button',{name:'Restaurar visão',exact:true}).click();await settled();assert.equal(await card.getByRole('button',{name:'90 dias',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>localStorage.getItem(Alpine.$data(document.querySelector('main')).rpStorageKey())),null);
  await card.getByRole('button',{name:'30 dias',exact:true}).click();await settled();
  for(const [tab,name] of [['overview','Visão geral'],['products','Produtos'],['replenishment','Reposição'],['movements','Movimentações']]){
   await card.getByRole('tab',{name,exact:true}).click();
   for(const format of ['csv','pdf']){const event=page.waitForEvent('download');await card.getByRole('button',{name:format==='csv'?'CSV':'Exportar PDF',exact:true}).click();await(await event).saveAs(path.join(out,tab+'.'+format));}
   await page.screenshot({path:path.join(out,tab+'.png'),fullPage:true});
  }
  assert.equal(fs.readFileSync(path.join(out,'movements.csv'),'utf8').split('\r\n').length,85);
  assert.equal(fs.readFileSync(path.join(out,'replenishment.csv'),'utf8').split('\r\n').length,4);
  await card.getByRole('button',{name:'Próximas',exact:true}).click();await settled();assert.match(await card.locator('.rp-pager:visible').innerText(),/26–50 de 84/);
  await card.getByLabel('Origem do movimento do estoque').selectOption('sale');await settled();assert.equal(await card.locator('.rst-movement-table tbody tr').count(),4);
  await card.getByLabel('Tipo de movimento do estoque').selectOption('in');await settled();await card.getByText('Nenhuma movimentação neste recorte',{exact:true}).waitFor();
  await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();await card.getByRole('tab',{name:'Visão geral',exact:true}).click();
  await card.locator('.rst-stock-table').getByRole('button',{name:'130/70-13',exact:true}).click();await card.getByRole('button',{name:'Abrir plano em Compras →',exact:true}).click();
  await page.waitForFunction(()=>Alpine.$data(document.querySelector('main')).currentPage==='compras');
  const plan=await page.evaluate(()=>{const app=Alpine.$data(document.querySelector('main'));return {tab:app.comprasTab,mode:app.comprasPriceMode,row:app.comprasReplenishment.rows.find(row=>row.measure==='130/70-13')};});
  assert.equal(plan.tab,'precos');assert.equal(plan.mode,'plan');assert.equal(plan.row.suggested_quantity,8);assert.equal(plan.row.in_transit_quantity,8);assert.equal(mutations,0);
  await page.evaluate(()=>{Alpine.$data(document.querySelector('main')).currentPage='relatorios';});
  mode='error';await card.getByRole('button',{name:'Atualizar',exact:true}).click();await card.getByText('Não foi possível consultar o estoque.',{exact:false}).waitFor();
  assert.equal(await card.getByRole('button',{name:'Exportar PDF',exact:true}).isDisabled(),true);
  mode='empty';await card.getByRole('button',{name:'Tentar novamente',exact:true}).click();await settled();await card.getByText('Nenhum produto neste recorte',{exact:true}).waitFor();
  mode='normal';await card.getByRole('button',{name:'Atualizar',exact:true}).click();await settled();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);console.log('PASS: quatro abas, seleção, reserva/trânsito, reposição, giro, paginação, visão salva, filtros, CSV/PDF, plano sem gravação, erro/vazio e celular.');
  if(process.argv.includes('--full')){
   const full=await browser.newPage({viewport:{width:1720,height:1300}}),fullErrors=[];full.on('pageerror',error=>fullErrors.push(error.message));
   await full.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
   await full.goto('http://127.0.0.1:'+server.address().port+'/admin/painel?full=1');await full.locator('#farejador-sidebar-nav').getByRole('link',{name:'Relatórios',exact:true}).click();
   await full.waitForFunction(()=>Alpine.$data(document.body).rst.data&&!Alpine.$data(document.body).rst.loading);
   assert.equal(otherReports,0);assert.equal(await full.locator('.rp-library-row:visible').count(),1);assert.equal(await full.getByRole('button',{name:'Abrir plano em Compras →'}).count(),0);
   await full.screenshot({path:path.join(out,'painel-completo.png'),fullPage:true});
   await full.setViewportSize({width:390,height:844});await full.screenshot({path:path.join(out,'painel-mobile.png'),fullPage:true});assert.equal(await full.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   fs.writeFileSync(path.join(out,'painel-completo.json'),JSON.stringify({fullErrors},null,2));assert.deepEqual([...new Set(fullErrors)].filter(value=>value!=='row is not defined'),[]);
   console.log('PASS: painel completo com permissão somente Estoque; nenhum erro novo.');await full.close();
  }
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));const {pool}=await import(pathToFileURL(path.join(root,'dist/persistence/db.js')));await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
