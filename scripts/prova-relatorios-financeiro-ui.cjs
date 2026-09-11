// Interface real com dados fictícios locais. Nenhuma conexão com produção.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
Object.assign(process.env,{FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test:test@127.0.0.1:1/test',CHATWOOT_HMAC_SECRET:'proof',ADMIN_AUTH_TOKEN:'proof'});
const root=path.resolve(__dirname,'..'),pub=path.join(root,'painel/public'),out=path.join(root,'artifacts/relatorios-financeiro');fs.mkdirSync(out,{recursive:true});
const html=fs.readFileSync(path.join(pub,'index.html'),'utf8'),section=html.slice(html.indexOf('<!-- RELATÓRIOS DA MATRIZ:'),html.indexOf('<!-- ═══ TELA: PLACEHOLDERS'));
const modules=['app.relatorios.parceiros.js','app.relatorios.parceiros.view.js','app.relatorios.parceiros.charts.js','app.relatorios.parceiros.export.js','app.relatorios.parceiros.pdf.js','app.relatorios.financeiro.js','app.relatorios.financeiro.view.js','app.relatorios.financeiro.charts.js','app.relatorios.financeiro.export.js','app.relatorios.financeiro.pdf.js','app.relatorios.pdf.core.js',...['logistica','estoque','compras'].flatMap(name=>['','.view','.export','.pdf'].map(suffix=>'app.relatorios.'+name+suffix+'.js')),...['','.view','.export','.pdf'].map(suffix=>'app.relatorios'+suffix+'.js')];
const shell=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/admin/painel/tailwind.css"><link rel="stylesheet" href="/admin/painel/relatorios.css"><link rel="stylesheet" href="/admin/painel/relatorios-financeiro.css"><style>body{margin:0;font-family:Inter,Arial,sans-serif;background:#f7f9fa}.proof-side{position:fixed;inset:0 auto 0 0;width:190px;background:#00483c;color:white;padding:24px 20px}.proof-side h2{font-size:25px;font-weight:700}.proof-side p{margin-top:28px}main{margin-left:190px}.proof-label{padding:8px 24px;background:#fff7dd;color:#806127;font-size:11px}[x-cloak]{display:none!important}@media(max-width:700px){.proof-side{display:none}main{margin:0}}</style>${modules.map(name=>'<script src="/admin/painel/'+name+'"></script>').join('')}
<script>window.proof=()=>{const s={currentPage:'relatorios',panelWorkplace:{id:'matrix'},adminUser:{username:'proof',role:'owner'},isMatrixPanel:()=>true,hasPanelModule:()=>true,apiHeaders:()=>({}),adminUnauthorized(){throw Error('Unauthorized')},bfOpen(){},renderBotMapa(){},async apiGet(u){const r=await fetch(u);if(!r.ok)throw Error('api_'+r.status);return r.json()}};for(const f of Object.values(PAINEL_MODULES))Object.defineProperties(s,Object.getOwnPropertyDescriptors(f()));s.rp.report='financeiro';return s}</script><script defer src="/admin/painel/vendor/alpine-3.14.9.min.js"></script></head><body><aside class="proof-side"><h2>Farejador</h2><small>DISTRIBUIÇÃO DE PNEUS</small><p>Resumo</p><p>Bot</p><p>Vendas</p><p>Clientes</p><p>Compras</p><p>Estoque</p><p>Logística</p><p>Financeiro</p><p>Rede</p><p>Catálogo</p><p>▥ Relatórios</p></aside><main x-data="proof()" x-init="rpOpen()"><div class="proof-label">VALIDAÇÃO LOCAL · dados fictícios</div>${section}</main></body></html>`;
(async()=>{
 const imp=name=>import(pathToFileURL(path.join(root,'dist/admin/painel/'+name+'.js')));
 const {buildFinancialReport}=await imp('queries-financial-report'),{financialReportQuery}=await imp('financial-report-filter'),{financialReportCsv}=await imp('financial-report-csv');
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date()),asOf=new Date().toISOString(),date=delta=>new Date(Date.parse(today+'T12:00:00Z')+delta*86400000).toISOString().slice(0,10);
 const snapshot={as_of:asOf,today,integration_status:'green',opening:[{source_type:'finance.opening',amount:8400}],movements:[],titles:[],pending_cost:[]};
 const base={id:'',source_type:'',source_id:'',description:'',reference:null,party:'Cliente Exemplo',competence_on:today,cash_on:null,category:null,payment_method:null,cash_account:null,reversal_of:null,reversed:false,revenue:0,cost:0,expense:0,gain:0,loss:0,cash_in:0,cash_out:0};
 for(let i=0;i<32;i++){
  const day=today.slice(0,8)+String(1+i%Number(today.slice(8))).padStart(2,'0'),origin=i%2?'commerce.order.':'commerce.wholesale_order.';
  snapshot.movements.push({...base,id:'sale'+i,source_type:origin+'revenue',source_id:'sale'+i,description:'Venda '+String(i+1).padStart(3,'0'),reference:'V-'+String(i+1).padStart(4,'0'),competence_on:day,revenue:2643.75},
   {...base,id:'cost'+i,source_type:origin+'cost',source_id:'sale'+i,description:'Custo dos pneus · venda '+(i+1),competence_on:day,cost:i===31?1884.53:1884.37},
   {...base,id:'received'+i,source_type:origin+'payment',source_id:'sale'+i,reference:'V-'+String(i+1).padStart(4,'0'),description:'Recebimento de venda '+(i+1),competence_on:day,cash_on:day,cash_in:2262.5,payment_method:'Pix',cash_account:'Conta principal'},
   {...base,id:'paid'+i,source_type:'commerce.wholesale_purchase.payment',source_id:'purchase'+i,reference:'C-'+String(i+1).padStart(4,'0'),description:'Pagamento de compra '+(i+1),party:'Fornecedor Exemplo',competence_on:day,cash_on:day,cash_out:1931.25,payment_method:'Pix',cash_account:'Conta principal'});
  snapshot.titles.push({id:'title'+i,source_id:'sale'+i,obligation_id:'obligation'+i,side:i%2?'payable':'receivable',type:i%2?'fornecedor':'fiado',name:(i%2?'Fornecedor':'Cliente')+' Exemplo '+(i+1),amount:800+i*10,due_on:i===31?null:date(i-4),category:null,count:1,origin:i%2?'compras':'atacado'});
 }
 for(const [i,category,amount] of [[0,'funcionario',7200],[1,'aluguel',3400],[2,'operacao',2200]])snapshot.movements.push({...base,id:'expense'+i,source_type:'commerce.matriz_expense.accrual',source_id:'expense'+i,description:'Despesa de '+category,category,expense:amount,competence_on:today.slice(0,8)+'01'});
 let mode='normal',otherReports=0,mutations=0;
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');if(req.method!=='GET')mutations++;
  if(url.pathname==='/admin/painel'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(url.searchParams.has('full')?html:shell);}
  if(url.pathname==='/admin/api/auth/me'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({user:{username:'proof',display_name:'Validação local',role:'admin'},workplace:{id:'matrix',kind:'matrix',name:'Matriz',role:'admin'},modules:['financeiro']}));}
  if(/\/relatorios\/(vendas|compras|estoque|logistica)/.test(url.pathname))otherReports++;
  if(url.pathname.startsWith('/admin/api/relatorios/financeiro')){
   const parsed=financialReportQuery.safeParse(Object.fromEntries(url.searchParams));if(!parsed.success){res.statusCode=400;return res.end('{}');}
   if(mode==='error'||mode==='disabled'){res.statusCode=mode==='error'?503:409;return res.end('{}');}
   const data=mode==='empty'?{...snapshot,movements:[],opening:[],titles:[]}:snapshot,report=buildFinancialReport(data,parsed.data);
   if(url.pathname.endsWith('exportar')){res.setHeader('Content-Type','text/csv');return res.end(financialReportCsv(report));}
   res.setHeader('Content-Type','application/json');return setTimeout(()=>res.end(JSON.stringify(report)),parsed.data.origin==='atacado'?160:10);
  }
  if(url.pathname.startsWith('/admin/api/')){res.statusCode=503;return res.end('{"error":"outside_local_proof"}');}
  const file=path.resolve(pub,url.pathname.replace('/admin/painel/','')),ext=path.extname(file);
  if(!file.startsWith(pub+path.sep)||!['.js','.css','.svg','.webp','.png','.json'].includes(ext)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.json':'application/json'})[ext]);res.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true,channel:'msedge'});
 try{
  const page=await browser.newPage({viewport:{width:1720,height:1300}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const card=page.locator('.rfin-report'),settled=()=>page.waitForFunction(()=>window.Alpine&&Alpine.$data(document.querySelector('main')).rfin.data&&!Alpine.$data(document.querySelector('main')).rfin.loading);
  await page.goto('http://127.0.0.1:'+server.address().port+'/admin/painel');await settled();assert.equal(await card.getByRole('tab').count(),4);
  assert.match(await card.locator('.rfin-hero').innerText(),/11\.500/);assert.equal(await card.locator('.rfin-result-line polyline').count(),1);
  await page.screenshot({path:path.join(out,'visao-geral.png'),fullPage:true});
  await card.getByRole('button',{name:'Semana',exact:true}).click();await settled();const week=await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rfin.from);
  await card.getByLabel('Próximo período do Financeiro',{exact:true}).click();await settled();assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rfin.from),week);
  await card.getByRole('button',{name:'Mês',exact:true}).click();await settled();
  await card.getByRole('tab',{name:'Fluxo de caixa',exact:true}).click();assert.match(await card.locator('.rp-kpis:visible').innerText(),/19\.000/);
  await card.locator('.rfin-cash-chart').getByRole('button',{name:new RegExp(today.slice(8)+'/'+today.slice(5,7))}).click();await settled();
  assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rfin.cash_day),today);assert.match(await card.locator('.rp-kpis:visible').innerText(),/19\.000/);
  await card.locator('.rfin-cash-table .rfin-row-button').first().click();assert.match(await card.locator('.rfin-detail:visible').innerText(),/Pix/);
  await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  await card.getByRole('button',{name:'Previsto',exact:true}).click();await settled();assert.equal(await card.locator('.rfin-titles-table tbody tr').count(),25);
  assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rfinRows.some(r=>!r.due_on||r.due_on<Alpine.$data(document.querySelector('main')).rfin.data.today)),false);
  await page.screenshot({path:path.join(out,'previsto.png'),fullPage:true});
  for(const format of ['csv','pdf']){const event=page.waitForEvent('download');await card.getByRole('button',{name:format==='csv'?'CSV':'Exportar PDF',exact:true}).click();await(await event).saveAs(path.join(out,'previsto.'+format));}
  await card.getByRole('button',{name:'Realizado',exact:true}).click();await settled();
  await card.getByRole('tab',{name:'Títulos',exact:true}).click();await card.getByLabel('Vencimento dos títulos').selectOption('overdue');await settled();assert.equal(await card.locator('.rfin-titles-table tbody tr').count(),4);
  await card.getByRole('button',{name:'Salvar visão',exact:true}).click();await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();await card.getByRole('button',{name:'Restaurar visão',exact:true}).click();await settled();assert.equal(await card.getByLabel('Vencimento dos títulos').inputValue(),'overdue');
  assert.equal(await page.evaluate(()=>localStorage.getItem(Alpine.$data(document.querySelector('main')).rpStorageKey())),null);
  await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  await card.getByLabel('Origem do relatório financeiro').selectOption('atacado');await card.getByLabel('Origem do relatório financeiro').selectOption('varejo');await settled();await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rfin.data.filters.origin),'varejo');
  await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  for(const [tab,name] of [['overview','Visão geral'],['result','Resultado'],['cash','Fluxo de caixa'],['titles','Títulos']]){
   await card.getByRole('tab',{name,exact:true}).click();
   for(const format of ['csv','pdf']){const event=page.waitForEvent('download');await card.getByRole('button',{name:format==='csv'?'CSV':'Exportar PDF',exact:true}).click();await(await event).saveAs(path.join(out,tab+'.'+format));}
   await page.screenshot({path:path.join(out,tab+'.png'),fullPage:true});
   if(tab!=='overview'){await card.getByRole('button',{name:'Próxima',exact:true}).click();assert.match(await card.locator('.rp-pagination:visible').innerText(),/26–/);}
  }
  assert.equal(fs.readFileSync(path.join(out,'cash.csv'),'utf8').split('\r\n').length,65);assert.equal(fs.readFileSync(path.join(out,'titles.csv'),'utf8').split('\r\n').length,33);
  mode='error';await card.getByRole('button',{name:'Atualizar',exact:true}).click();await card.getByText('Não foi possível consultar o relatório financeiro. Tente novamente.',{exact:true}).waitFor();assert.equal(await card.getByRole('button',{name:'Exportar PDF',exact:true}).isDisabled(),true);
  mode='disabled';await card.getByRole('button',{name:'Tentar novamente',exact:true}).click();await card.getByText('A leitura financeira está desativada ou há uma divergência de integração. Confira o módulo Financeiro.',{exact:true}).waitFor();
  mode='empty';await card.getByRole('button',{name:'Tentar novamente',exact:true}).click();await settled();await card.getByText('Nenhum registro encontrado com estes filtros.',{exact:true}).waitFor();
  mode='normal';await card.getByRole('button',{name:'Atualizar',exact:true}).click();await settled();await card.getByRole('tab',{name:'Visão geral',exact:true}).click();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.locator('.rp-mobile-library').inputValue(),'financeiro');
  assert.equal(await page.locator('.rfin-cash-overview .rfin-mini-kpis b').evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth)),true);
  assert.deepEqual(errors,[]);assert.equal(mutations,0);
  console.log('PASS: quatro abas, linha acumulada, caixa, dia/lançamento, previsão, títulos, filtros, paginação, visão salva, concorrência, CSV/PDF, erro/vazio e celular.');
  if(process.argv.includes('--full')){
   const full=await browser.newPage({viewport:{width:1720,height:1300}}),fullErrors=[];full.on('pageerror',e=>fullErrors.push(e.message));
   await full.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
   await full.goto('http://127.0.0.1:'+server.address().port+'/admin/painel?full=1');await full.locator('#farejador-sidebar-nav').getByRole('link',{name:'Relatórios',exact:true}).click();await full.waitForFunction(()=>Alpine.$data(document.body).rfin.data&&!Alpine.$data(document.body).rfin.loading);
   assert.equal(otherReports,0);assert.equal(await full.locator('.rp-library-row:visible').count(),1);await full.screenshot({path:path.join(out,'painel-completo.png'),fullPage:true});
   await full.setViewportSize({width:390,height:844});await full.screenshot({path:path.join(out,'painel-mobile.png'),fullPage:true});assert.equal(await full.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   fs.writeFileSync(path.join(out,'painel-completo.json'),JSON.stringify({fullErrors},null,2));assert.deepEqual([...new Set(fullErrors)].filter(e=>e!=='row is not defined'),[]);console.log('PASS: painel completo com somente Financeiro; nenhum erro novo ou acesso a outros relatórios.');await full.close();
  }
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));const {pool}=await import(pathToFileURL(path.join(root,'dist/persistence/db.js')));await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
