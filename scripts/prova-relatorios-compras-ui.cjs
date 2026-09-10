// Interface e agregação reais; dados fictícios locais, sem conexão com produção.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
Object.assign(process.env,{FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test:test@127.0.0.1:1/test',CHATWOOT_HMAC_SECRET:'proof',ADMIN_AUTH_TOKEN:'proof'});
const root=path.resolve(__dirname,'..'),pub=path.join(root,'painel/public'),out=path.join(root,'artifacts/relatorios-compras');fs.mkdirSync(out,{recursive:true});
const html=fs.readFileSync(path.join(pub,'index.html'),'utf8');
const section=html.slice(html.indexOf('<!-- RELATÓRIOS DA MATRIZ:'),html.indexOf('<!-- ═══ TELA: PLACEHOLDERS'));
const scripts=['app.relatorios.pdf.core.js','app.relatorios.estoque.js','app.relatorios.estoque.view.js','app.relatorios.estoque.export.js','app.relatorios.estoque.pdf.js','app.relatorios.compras.js','app.relatorios.compras.view.js','app.relatorios.compras.export.js','app.relatorios.compras.pdf.js','app.relatorios.js','app.relatorios.view.js','app.relatorios.export.js','app.relatorios.pdf.js'];
const shell=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/admin/painel/tailwind.css"><link rel="stylesheet" href="/admin/painel/relatorios.css"><link rel="stylesheet" href="/admin/painel/relatorios-compras.css"><style>body{margin:0;font-family:Inter,Arial,sans-serif;background:#f7f9fa}.proof-side{position:fixed;inset:0 auto 0 0;width:205px;background:#00483c;color:white;padding:25px 20px}.proof-side h2{font-size:25px;font-weight:700}.proof-side p{margin-top:28px}main{margin-left:205px}.proof-label{padding:8px 24px;background:#fff7dd;color:#806127;font-size:11px}[x-cloak]{display:none!important}@media(max-width:700px){.proof-side{display:none}main{margin:0}}</style>
${scripts.map(name=>`<script src="/admin/painel/${name}"></script>`).join('')}
<script>window.proof=()=>{const s={currentPage:'relatorios',panelWorkplace:{id:'matrix'},adminUser:{username:'proof',role:'owner'},isMatrixPanel:()=>true,hasPanelModule:()=>true,apiHeaders:()=>({}),adminUnauthorized(){throw Error('Unauthorized')},bfOpen(){},renderBotMapa(){},async apiGet(u){const r=await fetch(u);if(!r.ok)throw Error('api_'+r.status);return r.json()}};for(const f of Object.values(PAINEL_MODULES))Object.defineProperties(s,Object.getOwnPropertyDescriptors(f()));s.rp.report='compras';return s}</script><script defer src="/admin/painel/vendor/alpine-3.14.9.min.js"></script></head><body><aside class="proof-side"><h2>Farejador</h2><small>DISTRIBUIÇÃO DE PNEUS</small><p>Resumo</p><p>Bot</p><p>Vendas</p><p>Clientes</p><p>Compras</p><p>Estoque</p><p>Logística</p><p>Financeiro</p><p>Rede</p><p>Catálogo</p><p style="font-weight:bold;background:#ffffff20;padding:10px">▥ Relatórios</p></aside><main x-data="proof()" x-init="rpOpen()"><div class="proof-label">VALIDAÇÃO LOCAL · dados fictícios</div>${section}</main></body></html>`;
(async()=>{
 const imp=name=>import(pathToFileURL(path.join(root,'dist/admin/painel/'+name+'.js')));
 const {buildPurchaseReport}=await imp('queries-purchase-report'),{purchaseReportQuery}=await imp('purchase-report-period'),{purchaseReportCsv}=await imp('purchase-report-csv');
 const {reportComparison,reportAddDays}=await imp('report-period');
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
 const initial=purchaseReportQuery.parse({from:today.slice(0,7)+'-01',to:today}),previous=reportComparison(initial),rows=[];
 const measures=['130/70-13','90/90-12','110/70-17','180/55-17'],names=['Pneus Brasil','Distribuidora Nacional','Rio Pneus','Atacado Fluminense'];
 for(let i=0;i<80;i++){
  const purchase={purchase_id:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),order_code:'OC-2026-'+String(i+1).padStart(6,'0'),
   supplier_id:'00000000-0000-4000-9000-'+String(i%4+1).padStart(12,'0'),supplier_name:names[i%4],day:reportAddDays(initial.from,i%Number(today.slice(8))),
   received_on:i%3?today:null,status:i%3?'confirmed':'pending',full_total:52000,open:i%3?10000:52000,condition:i%3?'novo':'meia_vida',
   quantity:3,ordered:i%3?4:3,received:i%3?3:0,transit:i%3?0:3,base_unit_cost:10000};
  rows.push({...purchase,id:'item-'+i,measure:measures[i%4],brand:i%2?'Michelin':'Pirelli',value:32000});
  rows.push({...purchase,id:'other-'+i,measure:'100/80-17',brand:'Pirelli',value:20000});
 }
 for(let i=0;i<8;i++)rows.push({...rows[i],id:'old-'+i,purchase_id:'old-'+i,day:previous.from,value:18000});
 let mode='normal',payments=true,fullModules=['compras'],salesRequests=0;
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/admin/painel'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(url.searchParams.has('full')?html:shell);}
  if(url.pathname==='/admin/api/auth/me'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({user:{username:'proof',display_name:'Validação local',role:'admin'},workplace:{id:'matrix',kind:'matrix',name:'Matriz',role:'admin'},modules:fullModules}));}
  if(url.pathname.startsWith('/admin/api/relatorios/vendas'))salesRequests++;
  if(url.pathname.startsWith('/admin/api/relatorios/compras')){
   const parsed=purchaseReportQuery.safeParse(Object.fromEntries(url.searchParams));if(!parsed.success){res.statusCode=400;return res.end('{}');}
   if(mode==='error'){res.statusCode=503;return res.end('{}');}
   const report=buildPurchaseReport(mode==='empty'?[]:rows,parsed.data,payments);
   if(url.pathname.endsWith('exportar')){res.setHeader('Content-Type','text/csv');return res.end(purchaseReportCsv(report));}
   const {export_purchases,...payload}=report;
   if(url.pathname.endsWith('imprimir'))payload.purchases={total:export_purchases.length,offset:0,rows:export_purchases};
   res.setHeader('Content-Type','application/json');return setTimeout(()=>res.end(JSON.stringify(payload)),parsed.data.brand==='Pirelli'?180:10);
  }
  if(url.pathname.startsWith('/admin/api/')){res.statusCode=503;return res.end('{"error":"outside_local_proof"}');}
  const name=url.pathname.replace('/admin/painel/',''),file=path.resolve(pub,name),ext=path.extname(file);
  if(!file.startsWith(pub+path.sep)||!['.js','.css','.svg','.webp','.png','.json'].includes(ext)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.json':'application/json'})[ext]);res.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true,channel:'msedge'});
 try{
  const page=await browser.newPage({viewport:{width:1650,height:1170}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const settled=()=>page.waitForFunction(()=>window.Alpine&&Alpine.$data(document.querySelector('main')).rcomp.data&&!Alpine.$data(document.querySelector('main')).rcomp.loading);
  const card=page.locator('.rcomp-report');
  await page.goto('http://127.0.0.1:'+server.address().port+'/admin/painel');await settled();
  assert.equal(await card.getByRole('tab').count(),4);assert.equal(await card.locator('.rcomp-products:visible tbody').count(),5);
  await page.screenshot({path:path.join(out,'visao-geral.png'),fullPage:true});
  await card.locator('.rcomp-products tbody').first().getByRole('button').first().click();
  await card.getByRole('button',{name:'Ver compras deste produto →',exact:true}).filter({visible:true}).click();await settled();
  assert.equal(await card.getByRole('tab',{name:'Compras',exact:true}).getAttribute('aria-selected'),'true');
  assert.equal(await card.locator('.rcomp-purchases tbody tr').count(),25);
  await card.getByRole('button',{name:'Ver itens',exact:true}).first().click();await card.getByRole('dialog',{name:'Itens da compra'}).waitFor();
  assert.equal(await card.locator('.rp-modal:visible tbody tr').count(),1);
  await page.screenshot({path:path.join(out,'itens-da-compra.png'),fullPage:true});await card.getByRole('button',{name:'Fechar itens da compra'}).click();
  await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  await card.getByRole('button',{name:'Próximas',exact:true}).click();await settled();assert.match(await card.locator('.rp-pager:visible').innerText(),/26–50 de 80/);
  await card.getByRole('tab',{name:'Fornecedores',exact:true}).click();await card.locator('.rcomp-suppliers tbody tr').first().getByRole('button').click();
  await card.locator('.rcomp-supplier-detail:visible').waitFor();await page.screenshot({path:path.join(out,'fornecedores.png'),fullPage:true});
  await card.getByRole('button',{name:'Ver todos os produtos →',exact:true}).click();await settled();
  assert.notEqual(await card.getByLabel('Fornecedor do relatório').inputValue(),'');
  assert.equal(await card.getByRole('tab',{name:'Produtos',exact:true}).getAttribute('aria-selected'),'true');
  await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  await card.getByLabel('Marca das compras').selectOption('Pirelli');await card.getByLabel('Marca das compras').selectOption('Michelin');await settled();await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rcomp.data.filters.brand),'Michelin');
  await card.getByRole('button',{name:'Salvar visão',exact:true}).click();await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  await card.getByRole('button',{name:'Restaurar visão',exact:true}).click();await settled();assert.equal(await card.getByLabel('Marca das compras').inputValue(),'Michelin');
  assert.equal(await page.evaluate(()=>localStorage.getItem(Alpine.$data(document.querySelector('main')).rpStorageKey())),null,'Visão de compras não sobrescreve vendas');
  await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  for(const [tab,name] of [['overview','Visão geral'],['products','Produtos'],['suppliers','Fornecedores'],['purchases','Compras']]){
   await card.getByRole('tab',{name,exact:true}).click();
   await page.screenshot({path:path.join(out,tab+'.png'),fullPage:true});
   for(const format of ['csv','pdf']){
    const event=page.waitForEvent('download');await card.getByRole('button',{name:format==='csv'?'CSV':'Exportar PDF',exact:true}).click();
    await(await event).saveAs(path.join(out,tab+'.'+format));
   }
  }
  assert.equal(fs.readFileSync(path.join(out,'purchases.csv'),'utf8').split('\r\n').length,81);
  assert.equal(fs.readFileSync(path.join(out,'suppliers.csv'),'utf8').split('\r\n').length,5);
  assert.equal(fs.readFileSync(path.join(out,'purchases.pdf')).subarray(0,8).toString(),'%PDF-1.4');
  await card.getByLabel('Recebimento das compras').selectOption('received');await settled();assert.equal(await card.getByText('Em trânsito',{exact:true}).filter({visible:true}).count(),0);
  await card.getByRole('button',{name:'Personalizado',exact:true}).click();await card.getByLabel('Início das compras').fill('2026-02-02');await card.getByLabel('Fim das compras').fill('2026-02-01');
  assert.equal(await card.getByRole('button',{name:'Exportar PDF',exact:true}).isDisabled(),true);
  await card.getByRole('button',{name:'Aplicar período',exact:true}).click();await card.getByText('Escolha um período válido',{exact:false}).waitFor();
  mode='error';await card.getByRole('button',{name:'Mês',exact:true}).click();await card.getByText('Não foi possível carregar o relatório de compras.',{exact:false}).waitFor();
  mode='empty';await card.getByRole('button',{name:'Tentar novamente',exact:true}).click();await card.getByText('Nenhuma compra neste recorte',{exact:true}).waitFor();
  mode='normal';payments=false;await card.getByRole('button',{name:'Mês',exact:true}).click();await settled();
  assert.equal(await card.locator('.rcomp-financial:visible').count(),0);
  await card.getByRole('tab',{name:'Fornecedores',exact:true}).click();await card.locator('.rcomp-suppliers:visible').waitFor();assert.equal(await card.locator('.rcomp-suppliers th:visible').count(),4);
  payments=true;await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  await card.getByRole('tab',{name:'Visão geral',exact:true}).click();await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Sem overflow global no celular');
  assert.deepEqual(errors,[]);console.log('PASS: quatro abas, itens, fornecedores, filtros, concorrência, paginação, visão salva, recebimento, pagamentos restritos, CSV/PDF, erro/vazio e celular.');
  if(process.argv.includes('--full')){
   payments=false;const full=await browser.newPage({viewport:{width:1650,height:1320}}),fullErrors=[];
   full.on('pageerror',error=>fullErrors.push(error.message));await full.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
   await full.goto('http://127.0.0.1:'+server.address().port+'/admin/painel?full=1');
   await full.locator('#farejador-sidebar-nav').getByRole('link',{name:'Relatórios',exact:true}).click();
   await full.waitForFunction(()=>Alpine.$data(document.body).rcomp.data&&!Alpine.$data(document.body).rcomp.loading);
   assert.equal(salesRequests,0,'Usuário de Compras não consulta relatório de Vendas');
   assert.equal(await full.locator('.rp-library-row:visible').count(),1);
   assert.equal(await full.locator('.rcomp-financial:visible').count(),0);
   await full.screenshot({path:path.join(out,'painel-completo.png'),fullPage:true});
   await full.setViewportSize({width:390,height:844});await full.screenshot({path:path.join(out,'painel-mobile.png'),fullPage:true});
   assert.equal(await full.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   fs.writeFileSync(path.join(out,'painel-completo.json'),JSON.stringify({fullErrors},null,2));
   assert.deepEqual([...new Set(fullErrors)].filter(value=>value!=='row is not defined'),[]);
   console.log('PASS: painel completo com permissão somente Compras; nenhum erro novo.');await full.close();
  }
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));const {pool}=await import(pathToFileURL(path.join(root,'dist/persistence/db.js')));await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
