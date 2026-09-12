// Interface real com dados fictícios locais. Nenhuma conexão com produção.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
Object.assign(process.env,{FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test:test@127.0.0.1:1/test',CHATWOOT_HMAC_SECRET:'proof',ADMIN_AUTH_TOKEN:'proof'});
const root=path.resolve(__dirname,'..'),pub=path.join(root,'painel/public'),out=path.join(root,'artifacts/relatorios-faltas');fs.mkdirSync(out,{recursive:true});
const html=fs.readFileSync(path.join(pub,'index.html'),'utf8'),section=html.slice(html.indexOf('<!-- RELATÓRIOS DA MATRIZ:'),html.indexOf('<!-- ═══ TELA: PLACEHOLDERS'));
const modules=['app.relatorios.demanda.js','app.relatorios.demanda.view.js','app.relatorios.demanda.charts.js','app.relatorios.demanda.export.js','app.relatorios.demanda.pdf.js','app.relatorios.faltas.js','app.relatorios.faltas.view.js','app.relatorios.faltas.export.js','app.relatorios.faltas.pdf.js','app.relatorios.parceiros.js','app.relatorios.parceiros.view.js','app.relatorios.parceiros.charts.js','app.relatorios.parceiros.export.js','app.relatorios.parceiros.pdf.js','app.relatorios.financeiro.js','app.relatorios.financeiro.view.js','app.relatorios.financeiro.charts.js','app.relatorios.financeiro.export.js','app.relatorios.financeiro.pdf.js','app.relatorios.pdf.core.js',...['logistica','estoque','compras'].flatMap(name=>['','.view','.export','.pdf'].map(suffix=>'app.relatorios.'+name+suffix+'.js')),...['','.view','.export','.pdf'].map(suffix=>'app.relatorios'+suffix+'.js')];
const shell=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/admin/painel/tailwind.css"><link rel="stylesheet" href="/admin/painel/relatorios.css"><link rel="stylesheet" href="/admin/painel/relatorios-faltas.css"><style>body{margin:0;font-family:Inter,Arial,sans-serif;background:#f7f9fa}.proof-side{position:fixed;inset:0 auto 0 0;width:190px;background:#00483c;color:white;padding:24px 20px}.proof-side h2{font-size:25px;font-weight:700}.proof-side p{margin-top:28px}main{margin-left:190px}.proof-label{padding:8px 24px;background:#fff7dd;color:#806127;font-size:11px}[x-cloak]{display:none!important}@media(max-width:700px){.proof-side{display:none}main{margin:0}}</style>${modules.map(name=>'<script src="/admin/painel/'+name+'"></script>').join('')}
<script>window.proof=()=>{const s={currentPage:'relatorios',panelWorkplace:{id:'matrix'},adminUser:{username:'proof',role:'owner'},isMatrixPanel:()=>true,hasPanelModule:()=>true,apiHeaders:()=>({}),adminUnauthorized(){throw Error('Unauthorized')},bfOpen(){},renderBotMapa(){},async apiGet(u){const r=await fetch(u);if(!r.ok)throw Error('api_'+r.status);return r.json()}};for(const f of Object.values(PAINEL_MODULES))Object.defineProperties(s,Object.getOwnPropertyDescriptors(f()));s.rp.report='faltas';return s}</script><script defer src="/admin/painel/vendor/alpine-3.14.9.min.js"></script></head><body><aside class="proof-side"><h2>Farejador</h2><small>DISTRIBUIÇÃO DE PNEUS</small><p>Resumo</p><p>Bot</p><p>Vendas</p><p>Clientes</p><p>Compras</p><p>Estoque</p><p>Logística</p><p>Financeiro</p><p>Rede</p><p>Catálogo</p><p>▥ Relatórios</p></aside><main x-data="proof()" x-init="rpOpen()"><div class="proof-label">VALIDAÇÃO LOCAL · dados fictícios</div>${section}</main></body></html>`;
(async()=>{
 const imp=name=>import(pathToFileURL(path.join(root,'dist/admin/painel/'+name+'.js')));
 const {buildShortageReport}=await imp('queries-shortage-report'),{shortageReportQuery}=await imp('shortage-report-filter'),{shortageReportCsv}=await imp('shortage-report-csv');
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date()),asOf=new Date().toISOString(),uuid=i=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0');
 const names=['Alcântara','Fonseca','Itaipuaçu','Centro','Neves','Icaraí','Barreto','Mutuá'],measures=['90/90-12','130/70-13','110/70-17','180/55-17'];
 const snapshot={as_of:asOf,tracking_since:today.slice(0,7)+'-01T13:00:00Z',legacy_records:0,traces:[],products:[],stock:[],cities:[]};
 for(let i=0;i<8;i++)snapshot.cities.push({id:uuid(i+1),city:i===2?'Maricá':i%3===1?'Niterói':'São Gonçalo'});
 for(let m=0;m<4;m++){
  snapshot.products.push({id:uuid(100+m),measure:measures[m],brand:'Michelin',condition:'novo',position:'both',matrix_price:200+m*35,matrix_currency:'BRL',partner_price:m===3?null:180+m*30,partner_currency:'BRL'});
  for(let s=0;s<9;s++)snapshot.stock.push({store_id:s===8?'matriz':uuid(s+1),measure:measures[m],available:m===1||m===3?0:6+s,unknown:false});
 }
 for(let i=0;i<68;i++){
  const s=i<35?0:1+i%7,m=i%4,day=today.slice(0,8)+String(1+i%Number(today.slice(8))).padStart(2,'0');
  snapshot.traces.push({id:uuid(1000+i),conversation_id:uuid(2000+Math.floor(i/2)),search_key:'search-'+i,occurred_at:day+'T'+String(13+i%7).padStart(2,'0')+':42:00Z',measure:measures[m],municipality:snapshot.cities[s].city,
   filters:{condicao_pneu:'novo'},stores:[{id:uuid(s+1),name:'Parceiro '+names[s],available:false},{id:'matriz',name:'Matriz',available:i%5===0}]});
 }
 // Repeat a lookup from the same conversation, same measure: count it in history, once in potential.
 snapshot.traces.push({...snapshot.traces[0],id:uuid(9991),search_key:'repeat',occurred_at:today+'T19:59:00Z'});
 snapshot.traces.sort((a,b)=>b.occurred_at.localeCompare(a.occurred_at)||a.id.localeCompare(b.id));
 let mode='normal',otherReports=0,mutations=0;
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');if(req.method!=='GET')mutations++;
  if(url.pathname==='/admin/painel'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(url.searchParams.has('full')?html:shell);}
  if(url.pathname==='/admin/api/auth/me'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({user:{username:'proof',display_name:'Validação local',role:'admin'},workplace:{id:'matrix',kind:'matrix',name:'Matriz',role:'admin'},modules:['bot']}));}
  if(/\/relatorios\/(vendas|compras|estoque|logistica|financeiro|parceiros)/.test(url.pathname))otherReports++;
  if(url.pathname.startsWith('/admin/api/relatorios/faltas')){
   const parsed=shortageReportQuery.safeParse(Object.fromEntries(url.searchParams));if(!parsed.success){res.statusCode=400;return res.end('{}');}
   if(mode==='error'){res.statusCode=503;return res.end('{}');}
   const f=parsed.data,source=mode==='empty'?{...snapshot,traces:[]}:mode==='unpriced'?{...snapshot,products:[]}:snapshot;
   const data={...source,traces:source.traces.filter(t=>{const day=new Date(new Date(t.occurred_at).getTime()-3*3600000).toISOString().slice(0,10);return day>=f.from&&day<=f.to;})},report=buildShortageReport(data,f);
   if(url.pathname.endsWith('exportar')){res.setHeader('Content-Type','text/csv');return res.end(shortageReportCsv(report));}
   res.setHeader('Content-Type','application/json');return setTimeout(()=>res.end(JSON.stringify(report)),f.store===uuid(2)?160:10);
  }
  if(url.pathname.startsWith('/admin/api/')){res.statusCode=503;return res.end('{"error":"outside_local_proof"}');}
  const file=path.resolve(pub,url.pathname.replace('/admin/painel/','')),ext=path.extname(file);
  if(!file.startsWith(pub+path.sep)||!['.js','.css','.svg','.webp','.png','.json'].includes(ext)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.json':'application/json'})[ext]);res.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
 try{
  const page=await browser.newPage({viewport:{width:1720,height:1250}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const card=page.locator('.rfal-report'),settled=()=>page.waitForFunction(()=>window.Alpine&&Alpine.$data(document.querySelector('main')).rfal.data&&!Alpine.$data(document.querySelector('main')).rfal.loading);
  await page.goto('http://127.0.0.1:'+server.address().port+'/admin/painel');await settled();assert.equal(await card.getByRole('tab').count(),4);
  await card.locator('.rfal-store').filter({hasText:'Parceiro Alcântara'}).click();await settled();assert.equal(await card.locator('.rfal-store[aria-pressed=true] b').innerText(),'Parceiro Alcântara');
  await card.getByRole('button',{name:'90/90-12',exact:true}).click();await settled();assert.match(await card.getByLabel('Detalhes da consulta selecionada').innerText(),/90\/90-12/);
  assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rfal.data.store.potential.repeated),1);
  const measure=await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rfal.data.selected_measure);
  assert.equal(measure.shortages,measure.potential.opportunities);
  assert.equal(await card.locator('.rfal-measures tr.rp-selected td').nth(1).innerText(),String(measure.shortages));
  assert.match(await card.locator('.rfal-kpis').innerText(),/Conversas com falta/);
  assert.match(await card.locator('.rfal-queries').innerText(),/2 buscas nesta conversa e medida/);
  assert.match(await card.locator('.rfal-measure-potential').innerText(),/repetições removidas/);await page.screenshot({path:path.join(out,'visao-geral.png'),fullPage:true});
  await card.getByRole('button',{name:/Ver todas \(/}).click();await card.getByLabel('Buscar loja nas faltas').fill('Mutuá');assert.equal(await card.locator('.rfal-store:visible').count(),1);
  await card.locator('.rfal-store:visible').click();await settled();assert.equal(await card.locator('.rfal-store[aria-pressed=true] b').innerText(),'Parceiro Mutuá');
  await card.locator('.rfal-store').filter({hasText:'Parceiro Alcântara'}).click();await settled();
  await page.evaluate(()=>{const s=Alpine.$data(document.querySelector('main'));s.rfalStore('00000000-0000-4000-8000-000000000002');s.rfalStore('00000000-0000-4000-8000-000000000001');});await settled();await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rfal.data.store.id),uuid(1));
  for(const [tab,name] of [['overview','Visão geral'],['measures','Por medida'],['consultations','Consultas'],['potential','Potencial de venda']]){
   await card.getByRole('tab',{name,exact:true}).click();await settled();
   if(tab==='consultations'){await card.locator('.rfal-queries tbody tr button').nth(1).click();const selected=await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rfalConsultation.measure);assert.equal(await card.locator('.rfal-detail h3').innerText(),selected);
    assert.match(await card.locator('.rfal-measure-potential h4').innerText(),new RegExp(selected.replaceAll('/','\\/')));}
   for(const format of ['csv','pdf']){const event=page.waitForEvent('download');await card.getByRole('button',{name:format==='csv'?'CSV':'Exportar PDF',exact:true}).click();await(await event).saveAs(path.join(out,tab+'.'+format));}
   await page.screenshot({path:path.join(out,tab+'.png'),fullPage:true});
   if(['consultations','potential'].includes(tab)){await card.getByRole('button',{name:'Próxima',exact:true}).click();assert.match(await card.locator('.rfal-pagination:visible').innerText(),/21–/);}
  }
  const exported=fs.readFileSync(path.join(out,'potential.csv'),'utf8');assert.equal(exported.split('\r\n').length,47);assert.match(exported,/Sem referência/);assert.match(exported,/não lucro nem perda confirmada/);assert.match(exported,/Uma falta por conversa, medida e loja/);
  await card.getByLabel('Filtrar medida das consultas').selectOption('180/55-17');await settled();assert.match(await card.locator('.rfal-potential-table .rp-card-heading>strong').innerText(),/Sem referência/);
  const filteredPdf=page.waitForEvent('download');await card.getByRole('button',{name:'Exportar PDF',exact:true}).click();await(await filteredPdf).saveAs(path.join(out,'potential-filtered.pdf'));
  await card.getByRole('button',{name:'Salvar visão',exact:true}).click();await card.getByLabel('Filtrar medida das consultas').selectOption('');await settled();await card.getByRole('button',{name:'Restaurar visão',exact:true}).click();await settled();assert.equal(await card.getByLabel('Filtrar medida das consultas').inputValue(),'180/55-17');
  await card.getByLabel('Buscar medida nas faltas').fill('110 70');await page.waitForTimeout(450);await settled();assert.equal(await card.locator('.rfal-potential-table tbody tr').count(),9);
  await card.getByLabel('Buscar medida nas faltas').fill('');await page.waitForTimeout(450);await settled();
  await card.getByRole('button',{name:'Semana',exact:true}).click();await settled();await card.getByRole('button',{name:'Mês',exact:true}).click();await settled();
  await card.getByRole('button',{name:'Personalizado',exact:true}).click();await card.getByLabel('Início das faltas').fill('2026-02-28');await card.getByLabel('Fim das faltas').fill('2026-02-01');await card.getByRole('button',{name:'Aplicar período',exact:true}).click();await card.getByText('Escolha um período válido de até 366 dias, encerrado até hoje.',{exact:true}).waitFor();assert.equal(await card.getByRole('button',{name:'Exportar PDF',exact:true}).isDisabled(),true);
  await card.getByRole('button',{name:'Mês',exact:true}).click();await settled();mode='error';await card.getByRole('button',{name:'Atualizar',exact:true}).click();await card.getByText('Não foi possível consultar as faltas. Tente novamente.',{exact:true}).waitFor();assert.equal(await card.getByRole('button',{name:'Exportar PDF',exact:true}).isDisabled(),true);
  mode='empty';await card.getByRole('button',{name:'Tentar novamente',exact:true}).click();await settled();await card.getByText('Nenhuma falta por loja registrada neste período.',{exact:true}).waitFor();
  mode='unpriced';await card.getByRole('button',{name:'Atualizar',exact:true}).click();await settled();assert.match(await card.locator('.rfal-potential-number strong').innerText(),/Sem referência/);
  mode='normal';await card.getByRole('button',{name:'Atualizar',exact:true}).click();await settled();await card.getByRole('tab',{name:'Visão geral',exact:true}).click();await settled();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.locator('.rp-mobile-library').inputValue(),'faltas');
  assert.deepEqual(errors,[]);assert.equal(mutations,0);console.log('PASS: 4 abas, lojas pesquisáveis, medidas, trilha, potencial sem duplicatas, CSV/PDF completos, erros, vazio e celular.');
  if(process.argv.includes('--full')){
   const full=await browser.newPage({viewport:{width:1720,height:1250}}),fullErrors=[];full.on('pageerror',e=>fullErrors.push(e.message));
   await full.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
   await full.goto('http://127.0.0.1:'+server.address().port+'/admin/painel?full=1');await full.locator('#farejador-sidebar-nav').getByRole('link',{name:'Relatórios',exact:true}).click();await full.waitForFunction(()=>Alpine.$data(document.body).rfal.data&&!Alpine.$data(document.body).rfal.loading);
   assert.equal(otherReports,0);assert.equal(await full.locator('.rp-library-row:visible').count(),2);await full.screenshot({path:path.join(out,'painel-completo.png'),fullPage:true});
   await full.setViewportSize({width:390,height:844});await full.screenshot({path:path.join(out,'painel-mobile.png'),fullPage:true});assert.equal(await full.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   fs.writeFileSync(path.join(out,'painel-completo.json'),JSON.stringify({fullErrors},null,2));assert.deepEqual([...new Set(fullErrors)].filter(e=>e!=='row is not defined'),[]);console.log('PASS: painel completo com somente Bot, sem nova falha nem consulta a outro relatório.');await full.close();
  }
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));const {pool}=await import(pathToFileURL(path.join(root,'dist/persistence/db.js')));await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
