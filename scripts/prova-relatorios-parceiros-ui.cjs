// Interface real com dados fictícios locais. Nenhuma conexão com produção.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
Object.assign(process.env,{FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test:test@127.0.0.1:1/test',CHATWOOT_HMAC_SECRET:'proof',ADMIN_AUTH_TOKEN:'proof'});
const root=path.resolve(__dirname,'..'),pub=path.join(root,'painel/public'),out=path.join(root,'artifacts/relatorios-parceiros');fs.mkdirSync(out,{recursive:true});
const html=fs.readFileSync(path.join(pub,'index.html'),'utf8'),section=html.slice(html.indexOf('<!-- RELATÓRIOS DA MATRIZ:'),html.indexOf('<!-- ═══ TELA: PLACEHOLDERS'));
const modules=['app.relatorios.faltas.js','app.relatorios.faltas.view.js','app.relatorios.faltas.export.js','app.relatorios.faltas.pdf.js','app.relatorios.parceiros.js','app.relatorios.parceiros.view.js','app.relatorios.parceiros.charts.js','app.relatorios.parceiros.export.js','app.relatorios.parceiros.pdf.js','app.relatorios.financeiro.js','app.relatorios.financeiro.view.js','app.relatorios.financeiro.charts.js','app.relatorios.financeiro.export.js','app.relatorios.financeiro.pdf.js','app.relatorios.pdf.core.js',...['logistica','estoque','compras'].flatMap(name=>['','.view','.export','.pdf'].map(suffix=>'app.relatorios.'+name+suffix+'.js')),...['','.view','.export','.pdf'].map(suffix=>'app.relatorios'+suffix+'.js')];
const shell=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/admin/painel/tailwind.css"><link rel="stylesheet" href="/admin/painel/relatorios.css"><link rel="stylesheet" href="/admin/painel/relatorios-parceiros.css"><style>body{margin:0;font-family:Inter,Arial,sans-serif;background:#f7f9fa}.proof-side{position:fixed;inset:0 auto 0 0;width:190px;background:#00483c;color:white;padding:24px 20px}.proof-side h2{font-size:25px;font-weight:700}.proof-side p{margin-top:28px}main{margin-left:190px}.proof-label{padding:8px 24px;background:#fff7dd;color:#806127;font-size:11px}[x-cloak]{display:none!important}@media(max-width:700px){.proof-side{display:none}main{margin:0}}</style>${modules.map(name=>'<script src="/admin/painel/'+name+'"></script>').join('')}
<script>window.proof=()=>{const s={currentPage:'relatorios',panelWorkplace:{id:'matrix'},adminUser:{username:'proof',role:'owner'},isMatrixPanel:()=>true,hasPanelModule:()=>true,apiHeaders:()=>({}),adminUnauthorized(){throw Error('Unauthorized')},bfOpen(){},renderBotMapa(){},async apiGet(u){const r=await fetch(u);if(!r.ok)throw Error('api_'+r.status);return r.json()}};for(const f of Object.values(PAINEL_MODULES))Object.defineProperties(s,Object.getOwnPropertyDescriptors(f()));s.rp.report='rede';return s}</script><script defer src="/admin/painel/vendor/alpine-3.14.9.min.js"></script></head><body><aside class="proof-side"><h2>Farejador</h2><small>DISTRIBUIÇÃO DE PNEUS</small><p>Resumo</p><p>Bot</p><p>Vendas</p><p>Clientes</p><p>Compras</p><p>Estoque</p><p>Logística</p><p>Financeiro</p><p>Rede</p><p>Catálogo</p><p>▥ Relatórios</p></aside><main x-data="proof()" x-init="rpOpen()"><div class="proof-label">VALIDAÇÃO LOCAL · dados fictícios</div>${section}</main></body></html>`;
(async()=>{
 const imp=name=>import(pathToFileURL(path.join(root,'dist/admin/painel/'+name+'.js')));
 const {buildPartnerReport}=await imp('queries-partner-report'),{partnerReportQuery}=await imp('partner-report-filter'),{partnerReportCsv}=await imp('partner-report-csv');
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date()),asOf=new Date().toISOString(),uuid=i=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0');
 const oldMonth=new Date(today.slice(0,7)+'-01T12:00:00Z');oldMonth.setUTCMonth(oldMonth.getUTCMonth()-1);
 const prior=oldMonth.toISOString().slice(0,7),names=['Alcântara','Fonseca','Itaipuaçu','Centro','Neves','Icaraí','Barreto','Mutuá','Tribobó','Piratininga','Pacheco','Engenho'];
 const snapshot={as_of:asOf,today,commission_enabled:true,units:[],sales:[],commissions:[]};
 for(let i=0;i<12;i++)snapshot.units.push({id:uuid(200+i),partner_id:uuid(i+1),unit_id:uuid(100+i),name:'Parceiro '+names[i],partner_name:'Parceiro '+names[i],city:i===2?'Maricá':i%3===1?'Niterói':'São Gonçalo',neighborhood:names[i],status:i===10?'suspended':'active',archived:false});
 for(let i=0;i<48;i++){
  const index=i%8,day=today.slice(0,8)+String(1+i%Number(today.slice(8))).padStart(2,'0'),total=Math.round(450*(1+(7-index)/3)*100)/100,unit=snapshot.units[index];
  const row={id:uuid(1000+i),unit_id:unit.unit_id,day,source:i<32?'2w':'walkin_balcao',mode:i%3?'delivery':'pickup',total,freight:i%3?20:0,quantity:2,
   items:[{name:'Pneu 130/70-13',measure:'130/70-13',brand:'Michelin',quantity:2,price:(total-(i%3?20:0))/2,total:total-(i%3?20:0)}],commission_id:i<32?uuid(2000+i):null};
  if(i<30||i>=32)snapshot.sales.push(row);
  snapshot.sales.push({...row,id:uuid(3000+i),day:prior+day.slice(7),total:Math.round(total*0.8*100)/100,commission_id:null});
  if(i<32)snapshot.commissions.push({id:uuid(2000+i),partner_id:unit.partner_id,unit_id:unit.unit_id,order_id:row.id,base:total-row.freight,percent:5,amount:Math.round((total-row.freight)*5)/100,
   status:i>=30?'reversed':i<14?'settled':'open',day,settled_on:i<14||i>=30?today:null,reversed_on:i>=30?today:null,refund_status:i>=30?'pending':null,refund_amount:i>=30?Math.round((total-row.freight)*5)/100:0,refunded_on:null});
 }
 snapshot.commissions.push({...snapshot.commissions[14],id:uuid(9998),order_id:uuid(9999),day:'2025-01-01',amount:250,status:'open'});
 let mode='normal',otherReports=0,mutations=0;
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');if(req.method!=='GET')mutations++;
  if(url.pathname==='/admin/painel'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(url.searchParams.has('full')?html:shell);}
  if(url.pathname==='/admin/api/auth/me'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({user:{username:'proof',display_name:'Validação local',role:'admin'},workplace:{id:'matrix',kind:'matrix',name:'Matriz',role:'admin'},modules:['rede']}));}
  if(/\/relatorios\/(vendas|compras|estoque|logistica|financeiro)/.test(url.pathname))otherReports++;
  if(url.pathname.startsWith('/admin/api/relatorios/parceiros')){
   const parsed=partnerReportQuery.safeParse(Object.fromEntries(url.searchParams));if(!parsed.success){res.statusCode=400;return res.end('{}');}
   if(mode==='error'){res.statusCode=503;return res.end('{}');}
   const data=mode==='empty'?{...snapshot,units:[],sales:[],commissions:[]}:mode==='disabled'?{...snapshot,commission_enabled:false,commissions:[]}:snapshot,report=buildPartnerReport(data,parsed.data);
   if(url.pathname.endsWith('exportar')){res.setHeader('Content-Type','text/csv');return res.end(partnerReportCsv(report));}
   res.setHeader('Content-Type','application/json');return setTimeout(()=>res.end(JSON.stringify(report)),parsed.data.city==='Niterói'?160:10);
  }
  if(url.pathname.startsWith('/admin/api/')){res.statusCode=503;return res.end('{"error":"outside_local_proof"}');}
  const file=path.resolve(pub,url.pathname.replace('/admin/painel/','')),ext=path.extname(file);
  if(!file.startsWith(pub+path.sep)||!['.js','.css','.svg','.webp','.png','.json'].includes(ext)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.json':'application/json'})[ext]);res.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true,channel:'msedge'});
 try{
  const page=await browser.newPage({viewport:{width:1720,height:1250}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const card=page.locator('.rpar-report'),settled=()=>page.waitForFunction(()=>window.Alpine&&Alpine.$data(document.querySelector('main')).rpar.data&&!Alpine.$data(document.querySelector('main')).rpar.loading);
  await page.goto('http://127.0.0.1:'+server.address().port+'/admin/painel');await settled();assert.equal(await card.getByRole('tab').count(),4);
  assert.equal(await card.locator('.rpar-chart polyline').count(),2);assert.equal(await card.locator('.rpar-partners tbody tr').count(),5);
  await card.getByRole('button',{name:'Parceiro Fonseca',exact:true}).click();assert.match(await card.getByLabel('Detalhes do parceiro selecionado').innerText(),/Parceiro Fonseca/);
  await page.screenshot({path:path.join(out,'visao-geral.png'),fullPage:true});
  await card.getByRole('button',{name:'Semana',exact:true}).click();await settled();const week=await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rpar.from);
  await card.getByLabel('Próximo período dos parceiros',{exact:true}).click();await settled();assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rpar.from),week);
  await card.getByRole('button',{name:'Mês',exact:true}).click();await settled();
  await card.getByRole('button',{name:'Ver vendas do parceiro →',exact:true}).click();await settled();assert.equal(await card.getByLabel('Parceiro da lista').inputValue(),uuid(2));
  assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rpar.data.sales.every(s=>s.partner_name==='Parceiro Fonseca')),true);
  await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  await card.getByLabel('Origem das vendas').selectOption('direct');await settled();assert.equal(await card.locator('.rpar-sales tbody tr').count(),16);assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rpar.data.summary.orders),46);
  await card.getByRole('button',{name:'Salvar visão',exact:true}).click();await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();await card.getByRole('button',{name:'Restaurar visão',exact:true}).click();await settled();assert.equal(await card.getByLabel('Origem das vendas').inputValue(),'direct');
  assert.equal(await page.evaluate(()=>localStorage.getItem(Alpine.$data(document.querySelector('main')).rpStorageKey())),null);
  await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  await card.getByLabel('Município da loja').selectOption('Niterói');await card.getByLabel('Município da loja').selectOption('Maricá');await settled();await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rpar.data.filters.city),'Maricá');
  await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  for(const [tab,name] of [['overview','Visão geral'],['partners','Parceiros'],['sales','Vendas'],['commissions','Comissões']]){
   await card.getByRole('tab',{name,exact:true}).click();
   if(tab==='sales'){await card.locator('.rpar-sales .rpar-row-button').nth(1).click();assert.match(await card.getByLabel('Detalhes da venda',{exact:true}).innerText(),/130\/70-13/);}
   if(tab==='commissions'){await card.locator('.rpar-commissions .rpar-row-button').nth(1).click();assert.match(await card.getByLabel('Detalhes da comissão',{exact:true}).innerText(),/Percentual registrado/);}
   for(const format of ['csv','pdf']){const event=page.waitForEvent('download');await card.getByRole('button',{name:format==='csv'?'CSV':'Exportar PDF',exact:true}).click();await(await event).saveAs(path.join(out,tab+'.'+format));}
   await page.screenshot({path:path.join(out,tab+'.png'),fullPage:true});
   if(['sales','commissions'].includes(tab)){await card.getByRole('button',{name:'Próxima',exact:true}).click();assert.match(await card.locator('.rpar-pagination:visible').innerText(),/26–/);}
  }
  assert.equal(fs.readFileSync(path.join(out,'sales.csv'),'utf8').split('\r\n').length,47);assert.equal(fs.readFileSync(path.join(out,'commissions.csv'),'utf8').split('\r\n').length,33);
  await card.getByLabel('Recorte das comissões').selectOption('refund');await settled();assert.equal(await card.locator('.rpar-commissions tbody tr').count(),2);assert.match(await card.getByLabel('Detalhes da comissão',{exact:true}).innerText(),/devolução ao parceiro continua pendente/);
  await card.getByLabel('Recorte das comissões').selectOption('open');await settled();assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rpar.data.commissions.some(c=>c.day==='2025-01-01')),true);
  await card.getByRole('button',{name:'Personalizado',exact:true}).click();await card.getByLabel('Data inicial dos parceiros').fill('2026-02-28');await card.getByLabel('Data final dos parceiros').fill('2026-02-01');await card.getByRole('button',{name:'Aplicar período',exact:true}).click();await card.getByText('Escolha um período válido de até 366 dias, encerrado até hoje.',{exact:true}).waitFor();assert.equal(await card.getByRole('button',{name:'Exportar PDF',exact:true}).isDisabled(),true);
  await card.getByRole('button',{name:'Mês',exact:true}).click();await settled();
  mode='error';await card.getByRole('button',{name:'Atualizar',exact:true}).click();await card.getByText('Não foi possível consultar o desempenho dos parceiros. Tente novamente.',{exact:true}).waitFor();assert.equal(await card.getByRole('button',{name:'Exportar PDF',exact:true}).isDisabled(),true);
  mode='empty';await card.getByRole('button',{name:'Tentar novamente',exact:true}).click();await settled();await card.getByText('Nenhum registro encontrado com estes filtros.',{exact:true}).waitFor();
  mode='disabled';await card.getByRole('button',{name:'Atualizar',exact:true}).click();await settled();assert.match(await card.locator('.rp-kpis:visible').innerText(),/Não disponível/);
  mode='normal';await card.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();await card.getByRole('tab',{name:'Visão geral',exact:true}).click();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.locator('.rp-mobile-library').inputValue(),'rede');
  assert.deepEqual(errors,[]);assert.equal(mutations,0);console.log('PASS: 4 abas, seleção, origem, município, visão salva, concorrência, saldos/estornos, CSV/PDF completos, erros, vazio e celular.');
  if(process.argv.includes('--full')){
   const full=await browser.newPage({viewport:{width:1720,height:1250}}),fullErrors=[];full.on('pageerror',e=>fullErrors.push(e.message));
   await full.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
   await full.goto('http://127.0.0.1:'+server.address().port+'/admin/painel?full=1');await full.locator('#farejador-sidebar-nav').getByRole('link',{name:'Relatórios',exact:true}).click();await full.waitForFunction(()=>Alpine.$data(document.body).rpar.data&&!Alpine.$data(document.body).rpar.loading);
   assert.equal(otherReports,0);assert.equal(await full.locator('.rp-library-row:visible').count(),1);await full.screenshot({path:path.join(out,'painel-completo.png'),fullPage:true});
   await full.setViewportSize({width:390,height:844});await full.screenshot({path:path.join(out,'painel-mobile.png'),fullPage:true});assert.equal(await full.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   fs.writeFileSync(path.join(out,'painel-completo.json'),JSON.stringify({fullErrors},null,2));assert.deepEqual([...new Set(fullErrors)].filter(e=>e!=='row is not defined'),[]);console.log('PASS: painel completo com somente Rede; sem erro novo nem consulta a outros relatórios.');await full.close();
  }
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));const {pool}=await import(pathToFileURL(path.join(root,'dist/persistence/db.js')));await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
