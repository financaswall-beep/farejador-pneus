// Interface real com dados fictícios locais. Nenhuma conexão com produção.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
Object.assign(process.env,{FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test:test@127.0.0.1:1/test',CHATWOOT_HMAC_SECRET:'proof',ADMIN_AUTH_TOKEN:'proof'});
const root=path.resolve(__dirname,'..'),pub=path.join(root,'painel/public'),out=path.join(root,'artifacts/relatorios-logistica');fs.mkdirSync(out,{recursive:true});
const html=fs.readFileSync(path.join(pub,'index.html'),'utf8'),section=html.slice(html.indexOf('<!-- RELATÓRIOS DA MATRIZ:'),html.indexOf('<!-- ═══ TELA: PLACEHOLDERS'));
const modules=['app.relatorios.demanda.js','app.relatorios.demanda.view.js','app.relatorios.demanda.charts.js','app.relatorios.demanda.export.js','app.relatorios.demanda.pdf.js','app.relatorios.faltas.js','app.relatorios.faltas.view.js','app.relatorios.faltas.export.js','app.relatorios.faltas.pdf.js','app.relatorios.parceiros.js','app.relatorios.parceiros.view.js','app.relatorios.parceiros.charts.js','app.relatorios.parceiros.export.js','app.relatorios.parceiros.pdf.js','app.relatorios.financeiro.js','app.relatorios.financeiro.view.js','app.relatorios.financeiro.charts.js','app.relatorios.financeiro.export.js','app.relatorios.financeiro.pdf.js','app.relatorios.pdf.core.js',...['logistica','estoque','compras'].flatMap(name=>['','.view','.export','.pdf'].map(suffix=>'app.relatorios.'+name+suffix+'.js')),...['','.view','.export','.pdf'].map(suffix=>'app.relatorios'+suffix+'.js')];
const shell=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/admin/painel/tailwind.css"><link rel="stylesheet" href="/admin/painel/relatorios.css"><link rel="stylesheet" href="/admin/painel/relatorios-logistica.css"><style>body{margin:0;font-family:Inter,Arial,sans-serif;background:#f7f9fa}.proof-side{position:fixed;inset:0 auto 0 0;width:190px;background:#00483c;color:white;padding:24px 20px}.proof-side h2{font-size:25px;font-weight:700}.proof-side p{margin-top:28px}main{margin-left:190px}.proof-label{padding:8px 24px;background:#fff7dd;color:#806127;font-size:11px}[x-cloak]{display:none!important}@media(max-width:700px){.proof-side{display:none}main{margin:0}}</style>${modules.map(name=>'<script src="/admin/painel/'+name+'"></script>').join('')}
<script>window.proof=()=>{const s={currentPage:'relatorios',panelWorkplace:{id:'matrix'},adminUser:{username:'proof',role:'owner'},isMatrixPanel:()=>true,hasPanelModule:()=>true,apiHeaders:()=>({}),adminUnauthorized(){throw Error('Unauthorized')},bfOpen(){},renderBotMapa(){},async apiGet(u){const r=await fetch(u);if(!r.ok)throw Error('api_'+r.status);return r.json()}};for(const f of Object.values(PAINEL_MODULES))Object.defineProperties(s,Object.getOwnPropertyDescriptors(f()));s.rp.report='logistica';return s}</script><script defer src="/admin/painel/vendor/alpine-3.14.9.min.js"></script></head><body><aside class="proof-side"><h2>Farejador</h2><small>DISTRIBUIÇÃO DE PNEUS</small><p>Resumo</p><p>Bot</p><p>Vendas</p><p>Clientes</p><p>Compras</p><p>Estoque</p><p>Logística</p><p>Financeiro</p><p>Rede</p><p>Catálogo</p><p>▥ Relatórios</p></aside><main x-data="proof()" x-init="rpOpen()"><div class="proof-label">VALIDAÇÃO LOCAL · dados fictícios</div>${section}</main></body></html>`;
(async()=>{
 const imp=name=>import(pathToFileURL(path.join(root,'dist/admin/painel/'+name+'.js')));
 const {buildLogisticsReport}=await imp('queries-logistics-report'),{logisticsReportQuery}=await imp('logistics-report-filter'),{logisticsReportCsv}=await imp('logistics-report-csv');
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date()),asOf=new Date().toISOString(),id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
 const snapshot={as_of:asOf,trips:[],deliveries:[],expenses:[],receipts:[]};
 for(let i=0;i<31;i++){
  const tripId=id(i+1),day=today.slice(0,8)+String(Math.max(1,Number(today.slice(8))-i%7)).padStart(2,'0');
  snapshot.trips.push({id:tripId,number:'R'+String(18+i).padStart(3,'0'),courier:i%2?'Bruno':'Carlos',courier_id:null,
   status:i===30?'open':'closed',started_at:day+'T11:10:00.000Z',ended_at:i===30?null:day+'T15:30:00.000Z',day,
   km_start:100,km_end:i===30?null:148,fuel_recorded:i===0?76:30,financial_status:i===30?'pending':'reconciled'});
  for(let j=0;j<(i===0?8:2);j++)snapshot.deliveries.push({id:'delivery-'+i+'-'+j,trip_id:tripId,order_id:id(1000+i*10+j),number:'P'+String(1000+i*10+j),
   customer:'Cliente fictício '+(j+1),status:i===0&&j>=6?'failed':'delivered',cancelled:false,reason:i===0&&j===6?'Cliente ausente':i===0&&j===7?'Endereço não localizado':null,
   scheduled:day,dispatched_at:day+'T11:10:00.000Z',delivered_at:i===0&&j>=6?null:day+'T14:00:00.000Z',historical:i===0&&j>=6,freight:i===0?21.5:20});
  const expenseId=id(500+i),receiptId=id(600+i);
  snapshot.expenses.push({id:expenseId,trip_id:tripId,category:'combustivel',amount:i===0?76:30,occurred_at:asOf,receipt_ids:[receiptId],legacy:false});
  snapshot.receipts.push({id:receiptId,trip_id:tripId,created_at:asOf,workflow:'linked',expense_id:expenseId,missing_expense:false});
 }
 snapshot.expenses.push({id:id(800),trip_id:id(1),category:'pedagio',amount:20,occurred_at:asOf,receipt_ids:[id(801)],legacy:false});
 snapshot.receipts.push({id:id(801),trip_id:id(1),created_at:asOf,workflow:'linked',expense_id:id(800),missing_expense:false},
  {id:id(802),trip_id:id(2),created_at:asOf,workflow:'review_required',expense_id:null,missing_expense:false});
 let mode='normal',receiptError=false,otherReports=0,mutations=0;
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');if(req.method!=='GET')mutations++;
  if(url.pathname==='/admin/painel'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(url.searchParams.has('full')?html:shell);}
  if(url.pathname==='/admin/api/auth/me'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({user:{username:'proof',display_name:'Validação local',role:'admin'},workplace:{id:'matrix',kind:'matrix',name:'Matriz',role:'admin'},modules:['logistica']}));}
  if(/\/relatorios\/(vendas|compras|estoque)/.test(url.pathname))otherReports++;
  if(/\/logistica\/comprovantes\/.*\/imagem/.test(url.pathname)){
   if(receiptError){res.statusCode=404;return res.end();}res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="420" height="520"><rect width="420" height="520" fill="white"/><text x="25" y="60" font-family="Arial" font-size="20">COMPROVANTE FICTÍCIO</text><text x="25" y="120" font-family="Arial" font-size="18">Combustível · R$ 76,00</text><text x="25" y="175" font-family="Arial" font-size="14">Somente validação local</text></svg>');
  }
  if(url.pathname.startsWith('/admin/api/relatorios/logistica')){
   const parsed=logisticsReportQuery.safeParse(Object.fromEntries(url.searchParams));if(!parsed.success){res.statusCode=400;return res.end('{}');}
   if(mode==='error'){res.statusCode=503;return res.end('{}');}
   const trips=mode==='empty'?[]:snapshot.trips.filter(row=>row.day>=parsed.data.from&&row.day<=parsed.data.to),ids=new Set(trips.map(row=>row.id));
   const report=buildLogisticsReport({...snapshot,trips,deliveries:snapshot.deliveries.filter(row=>ids.has(row.trip_id)),expenses:snapshot.expenses.filter(row=>ids.has(row.trip_id)),receipts:snapshot.receipts.filter(row=>ids.has(row.trip_id))},parsed.data);
   if(url.pathname.endsWith('exportar')){res.setHeader('Content-Type','text/csv');return res.end(logisticsReportCsv(report));}
   res.setHeader('Content-Type','application/json');return setTimeout(()=>res.end(JSON.stringify(report)),parsed.data.status==='open'?190:10);
  }
  if(url.pathname.startsWith('/admin/api/')){res.statusCode=503;return res.end('{"error":"outside_local_proof"}');}
  const name=url.pathname.replace('/admin/painel/',''),file=path.resolve(pub,name),ext=path.extname(file);
  if(!file.startsWith(pub+path.sep)||!['.js','.css','.svg','.webp','.png','.json'].includes(ext)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.json':'application/json'})[ext]);res.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true,channel:'msedge'});
 try{
  const page=await browser.newPage({viewport:{width:1720,height:1180}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const card=page.locator('.rlog-report'),settled=()=>page.waitForFunction(()=>window.Alpine&&Alpine.$data(document.querySelector('main')).rlog.data&&!Alpine.$data(document.querySelector('main')).rlog.loading);
  await page.goto('http://127.0.0.1:'+server.address().port+'/admin/painel');await settled();assert.equal(await card.getByRole('tab').count(),4);
  await card.getByRole('button',{name:'Semana',exact:true}).click();await settled();
  const week=await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rlog.from);
  await card.getByLabel('Próximo período da Logística',{exact:true}).click();await settled();
  assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rlog.from),week);
  await card.getByLabel('Período anterior da Logística',{exact:true}).click();await settled();
  assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rlog.from),new Date(Date.parse(week+'T12:00:00Z')-7*86400000).toISOString().slice(0,10));
  await card.getByRole('button',{name:'Mês',exact:true}).click();await settled();
  await card.locator('.rlog-table').getByRole('button',{name:/R018/}).click();assert.match(await card.locator('.rlog-total').innerText(),/R\$\s*33,00/);
  await page.screenshot({path:path.join(out,'visao-geral.png'),fullPage:true});
  await card.getByRole('button',{name:'Ver as 8 entregas →',exact:true}).click();await settled();assert.equal(await card.locator('.rlog-deliveries-table tbody tr').count(),8);
  await card.getByLabel('Situação das entregas').selectOption('failed');await settled();assert.equal(await card.locator('.rlog-deliveries-table tbody tr').count(),2);
  await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  await card.getByRole('tab',{name:'Custos e comprovantes',exact:true}).click();await card.getByLabel('Situação dos comprovantes').selectOption('pending');await settled();
  assert.equal(await card.locator('.rlog-costs-table tbody tr').count(),1);await card.getByText('Sem lançamento',{exact:true}).waitFor();
  await card.getByRole('button',{name:'Ver 1',exact:true}).click();await page.locator('.rlog-receipt-dialog[open] img').waitFor();
  assert.equal(await page.locator('.rlog-receipt-dialog img').evaluate(el=>el.naturalWidth>0),true);await page.keyboard.press('Escape');await page.locator('.rlog-receipt-dialog').waitFor({state:'hidden'});
  receiptError=true;await card.getByRole('button',{name:'Ver 1',exact:true}).click();await page.getByText('Não foi possível abrir este comprovante.',{exact:true}).waitFor();await page.getByRole('button',{name:'Fechar',exact:true}).click();receiptError=false;
  await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  await card.getByLabel('Situação das rotas').selectOption('open');await card.getByLabel('Situação das rotas').selectOption('closed');await settled();await page.waitForTimeout(240);
  assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rlog.data.filters.status),'closed');
  await card.getByRole('button',{name:'Salvar visão',exact:true}).click();await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  await card.getByRole('button',{name:'Restaurar visão',exact:true}).click();await settled();assert.equal(await card.getByLabel('Situação das rotas').inputValue(),'closed');
  assert.equal(await page.evaluate(()=>localStorage.getItem(Alpine.$data(document.querySelector('main')).rpStorageKey())),null);
  await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  for(const [tab,name] of [['overview','Visão geral'],['trips','Rotas'],['deliveries','Entregas'],['costs','Custos e comprovantes']]){
   await card.getByRole('tab',{name,exact:true}).click();
   for(const format of ['csv','pdf']){const event=page.waitForEvent('download');await card.getByRole('button',{name:format==='csv'?'CSV':'Exportar PDF',exact:true}).click();await(await event).saveAs(path.join(out,tab+'.'+format));}
   await page.screenshot({path:path.join(out,tab+'.png'),fullPage:true});
   if(tab!=='overview'){await card.getByRole('button',{name:'Próximas',exact:true}).click();assert.match(await card.locator('.rp-pager:visible').innerText(),/26–/);}
  }
  assert.equal(fs.readFileSync(path.join(out,'trips.csv'),'utf8').split('\r\n').length,32);assert.equal(fs.readFileSync(path.join(out,'deliveries.csv'),'utf8').split('\r\n').length,69);
  await card.getByRole('tab',{name:'Visão geral',exact:true}).click();await card.getByRole('button',{name:'Abrir Logística →',exact:true}).click();assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).currentPage),'logistica');assert.equal(mutations,0);
  await page.evaluate(()=>Alpine.$data(document.querySelector('main')).currentPage='relatorios');mode='error';await card.getByRole('button',{name:'Atualizar',exact:true}).click();await card.getByText('Não foi possível consultar as rotas. Tente novamente.',{exact:true}).waitFor();assert.equal(await card.getByRole('button',{name:'Exportar PDF',exact:true}).isDisabled(),true);
  mode='empty';await card.getByRole('button',{name:'Tentar novamente',exact:true}).click();await settled();await card.getByText('Nenhuma rota neste recorte',{exact:true}).waitFor();
  mode='normal';await card.getByRole('button',{name:'Atualizar',exact:true}).click();await settled();await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  console.log('PASS: quatro abas, rota selecionada, entregas/falhas, custos, comprovantes, paginação, concorrência, visão salva, CSV/PDF, erro/vazio e celular.');
  if(process.argv.includes('--full')){
   const full=await browser.newPage({viewport:{width:1720,height:1300}}),fullErrors=[];full.on('pageerror',e=>fullErrors.push(e.message));
   await full.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
   await full.goto('http://127.0.0.1:'+server.address().port+'/admin/painel?full=1');await full.locator('#farejador-sidebar-nav').getByRole('link',{name:'Relatórios',exact:true}).click();
   await full.waitForFunction(()=>Alpine.$data(document.body).rlog.data&&!Alpine.$data(document.body).rlog.loading);
   assert.equal(otherReports,0);assert.equal(await full.locator('.rp-library-row:visible').count(),1);
   await full.screenshot({path:path.join(out,'painel-completo.png'),fullPage:true});await full.setViewportSize({width:390,height:844});await full.screenshot({path:path.join(out,'painel-mobile.png'),fullPage:true});assert.equal(await full.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   fs.writeFileSync(path.join(out,'painel-completo.json'),JSON.stringify({fullErrors},null,2));assert.deepEqual([...new Set(fullErrors)].filter(e=>e!=='row is not defined'),[]);console.log('PASS: painel completo com somente Logística; nenhum erro novo e nenhum acesso aos outros relatórios.');await full.close();
  }
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));const {pool}=await import(pathToFileURL(path.join(root,'dist/persistence/db.js')));await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
