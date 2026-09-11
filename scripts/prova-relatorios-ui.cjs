// Tela e agregação reais com linhas fictícias locais; nenhum acesso a produção.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
Object.assign(process.env,{FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test:test@127.0.0.1:1/test',CHATWOOT_HMAC_SECRET:'proof',ADMIN_AUTH_TOKEN:'proof'});
const root=path.resolve(__dirname,'..'),pub=path.join(root,'painel/public'),out=path.join(root,'artifacts/relatorios');
fs.mkdirSync(out,{recursive:true});
const html=fs.readFileSync(path.join(pub,'index.html'),'utf8');
const section=html.slice(html.indexOf('<!-- RELATÓRIOS DA MATRIZ:'),html.indexOf('<!-- ═══ TELA: PLACEHOLDERS'));
const scripts=['app.relatorios.demanda.js','app.relatorios.demanda.view.js','app.relatorios.demanda.charts.js','app.relatorios.demanda.export.js','app.relatorios.demanda.pdf.js','app.relatorios.faltas.js','app.relatorios.faltas.view.js','app.relatorios.faltas.export.js','app.relatorios.faltas.pdf.js','app.relatorios.parceiros.js','app.relatorios.parceiros.view.js','app.relatorios.parceiros.charts.js','app.relatorios.parceiros.export.js','app.relatorios.parceiros.pdf.js','app.relatorios.financeiro.js','app.relatorios.financeiro.view.js','app.relatorios.financeiro.charts.js','app.relatorios.financeiro.export.js','app.relatorios.financeiro.pdf.js','app.relatorios.logistica.js','app.relatorios.logistica.view.js','app.relatorios.logistica.export.js','app.relatorios.logistica.pdf.js','app.relatorios.pdf.core.js','app.relatorios.estoque.js','app.relatorios.estoque.view.js','app.relatorios.estoque.export.js','app.relatorios.estoque.pdf.js','app.relatorios.compras.js','app.relatorios.compras.view.js','app.relatorios.compras.export.js','app.relatorios.compras.pdf.js','app.relatorios.js','app.relatorios.view.js','app.relatorios.export.js','app.relatorios.pdf.js'];
const shell=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/admin/painel/tailwind.css"><link rel="stylesheet" href="/admin/painel/relatorios.css"><style>body{margin:0;font-family:Inter,Arial,sans-serif;background:#f7f9fa}.proof-side{position:fixed;inset:0 auto 0 0;width:205px;background:#00483c;color:white;padding:25px 20px}.proof-side h2{font-size:25px;font-weight:700}.proof-side p{margin-top:28px}main{margin-left:205px}.proof-label{padding:8px 24px;background:#fff7dd;color:#806127;font-size:11px}[x-cloak]{display:none!important}@media(max-width:700px){.proof-side{display:none}main{margin:0}}</style>
${scripts.map(name=>`<script src="/admin/painel/${name}"></script>`).join('')}
<script>window.proof=()=>{const s={currentPage:'relatorios',panelWorkplace:{id:'matrix'},adminUser:{username:'proof',role:'owner'},isMatrixPanel:()=>true,hasPanelModule:()=>true,apiHeaders:()=>({}),adminUnauthorized(){throw Error('Unauthorized')},bfOpen(){this.botTab='faltas'},renderBotMapa(){},async apiGet(u){const r=await fetch(u);if(!r.ok)throw Error('api_'+r.status);return r.json()}};for(const f of Object.values(PAINEL_MODULES))Object.defineProperties(s,Object.getOwnPropertyDescriptors(f()));return s}</script><script defer src="/admin/painel/vendor/alpine-3.14.9.min.js"></script></head><body><aside class="proof-side"><h2>Farejador</h2><small>DISTRIBUIÇÃO DE PNEUS</small><p>Resumo</p><p>Bot</p><p>Vendas</p><p>Clientes</p><p>Compras</p><p>Estoque</p><p>Logística</p><p>Financeiro</p><p>Rede</p><p>Catálogo</p><p style="font-weight:bold;background:#ffffff20;padding:10px">▥ Relatórios</p></aside><main x-data="proof()" x-init="rpOpen()"><div class="proof-label">VALIDAÇÃO LOCAL · dados fictícios</div>${section}</main></body></html>`;
(async()=>{
 const {buildSalesReport}=await import(pathToFileURL(path.join(root,'dist/admin/painel/queries-sales-report.js')));
 const {salesReportQuery,salesReportComparison,reportAddDays}=await import(pathToFileURL(path.join(root,'dist/admin/painel/sales-report-period.js')));
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
 const initial=salesReportQuery.parse({from:today.slice(0,7)+'-01',to:today}),previous=salesReportComparison(initial),rows=[];
 const measures=['130/70-13','90/90-12','110/70-17','180/55-17'];
 for(let i=0;i<80;i++)rows.push({id:'line-'+i,sale_id:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),channel:i%3?'atacado':'varejo',day:reportAddDays(initial.from,i%Number(today.slice(8))),measure:measures[i%4],brand:i%2?'Michelin':'Pirelli',condition:i%3?'novo':'meia_vida',kind:'tire',quantity:3,revenue:42000+(i%4)*6500,cost:30000});
 for(let i=0;i<8;i++)rows.push({...rows[i],id:'old-'+i,sale_id:'old-'+i,day:previous.from,revenue:25000});
 let mode='normal',costs=true;
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/admin/painel'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(url.searchParams.has('full')?html:shell);}
  if(url.pathname==='/admin/api/auth/me'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({user:{username:'proof',display_name:'Validação local',role:'owner'},workplace:{id:'matrix',kind:'matrix',name:'Matriz',role:'owner'},modules:['vendas','financeiro']}));}
  if(url.pathname.startsWith('/admin/api/relatorios/vendas')){
   const parsed=salesReportQuery.safeParse(Object.fromEntries(url.searchParams));
   if(!parsed.success){res.statusCode=400;return res.end('{}');}
   if(mode==='error'){res.statusCode=503;return res.end('{}');}
   const report=buildSalesReport(mode==='empty'?[]:rows.filter(row=>parsed.data.channel==='all'||row.channel===parsed.data.channel),parsed.data,costs);
   if(url.pathname.endsWith('exportar')){res.setHeader('Content-Type','text/csv');return res.end('Venda;Medida\r\n'+report.export_sales.map(s=>s.id+';'+s.items[0].measure).join('\r\n'));}
   const {export_sales,...data}=report;if(url.pathname.endsWith('imprimir'))data.sales.rows=export_sales;
   res.setHeader('Content-Type','application/json');
   const send=()=>res.end(JSON.stringify(data));if(parsed.data.brand==='Pirelli')return setTimeout(send,180);return send();
  }
  if(url.pathname.startsWith('/admin/api/')){res.statusCode=503;return res.end('{"error":"outside_local_proof"}');}
  const name=url.pathname.replace('/admin/painel/',''),file=path.resolve(pub,name),ext=path.extname(file);
  if(!file.startsWith(pub+path.sep)||!['.js','.css','.svg','.webp','.png','.json'].includes(ext)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.json':'application/json'})[ext]);res.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true,channel:'msedge'});
 try{
  const page=await browser.newPage({viewport:{width:1650,height:1170}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const settled=()=>page.waitForFunction(()=>window.Alpine&&Alpine.$data(document.querySelector('main')).rp.data&&!Alpine.$data(document.querySelector('main')).rp.loading);
  await page.goto('http://127.0.0.1:'+server.address().port+'/admin/painel');await settled();
  assert.equal(await page.locator('.rp-table:visible tbody').count(),4);
  await page.locator('.rp-table:visible tbody').first().getByRole('button').first().click();
  await page.locator('.rp-variants:visible').waitFor();
  await page.screenshot({path:path.join(out,'desktop.png'),fullPage:true});
  await page.locator('button:visible').filter({hasText:'Ver vendas desta medida →'}).click();await settled();
  assert.equal(await page.locator('.rp-tabs:visible [aria-selected=true]').innerText(),'Vendas');
  assert.equal(await page.locator('.rp-table:visible tbody tr').count(),20);
  await page.getByRole('button',{name:'Ver itens',exact:true}).first().click();await page.getByRole('dialog',{name:'Itens da venda'}).waitFor();
  assert.equal(await page.locator('.rp-modal:visible tbody tr').count(),1);await page.getByRole('button',{name:'Fechar itens da venda'}).click();
  await page.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  assert.equal(await page.locator('.rp-table:visible tbody tr').count(),25);
  await page.getByRole('button',{name:'Próximas',exact:true}).click();await settled();
  assert.match(await page.locator('.rp-pager:visible').innerText(),/26–50 de 80/);
  await page.getByRole('tab',{name:'Visão geral',exact:true}).click();
  await page.getByLabel('Marca do relatório').selectOption('Pirelli');await page.getByLabel('Marca do relatório').selectOption('Michelin');await settled();await page.waitForTimeout(220);
  assert.equal(await page.evaluate(()=>Alpine.$data(document.querySelector('main')).rp.data.filters.brand),'Michelin');
  await page.getByRole('button',{name:'Salvar visão',exact:true}).click();
  await page.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  await page.getByRole('button',{name:'Restaurar visão',exact:true}).click();await settled();assert.equal(await page.getByLabel('Marca do relatório').inputValue(),'Michelin');
  await page.getByRole('button',{name:'Limpar filtros',exact:true}).click();await settled();
  const csvEvent=page.waitForEvent('download');await page.getByRole('button',{name:'CSV',exact:true}).click();const csv=await csvEvent;await csv.saveAs(path.join(out,'vendas.csv'));
  assert.equal(fs.readFileSync(path.join(out,'vendas.csv'),'utf8').split('\r\n').length,81);
  const pdfEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Exportar PDF',exact:true}).click();const pdf=await pdfEvent;await pdf.saveAs(path.join(out,'vendas.pdf'));
  assert.equal(fs.readFileSync(path.join(out,'vendas.pdf')).subarray(0,8).toString(),'%PDF-1.4');
  await page.getByRole('tab',{name:'Vendas',exact:true}).click();
  const salesPdfEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Exportar PDF',exact:true}).click();await (await salesPdfEvent).saveAs(path.join(out,'vendas-detalhadas.pdf'));
  await page.getByRole('tab',{name:'Produtos',exact:true}).click();
  const productsPdfEvent=page.waitForEvent('download');await page.getByRole('button',{name:'Exportar PDF',exact:true}).click();await (await productsPdfEvent).saveAs(path.join(out,'produtos.pdf'));
  await page.getByRole('tab',{name:'Visão geral',exact:true}).click();
  await page.getByRole('button',{name:'Personalizado',exact:true}).click();await page.getByLabel('Início do relatório').fill('2026-02-02');await page.getByLabel('Fim do relatório').fill('2026-02-01');
  assert.equal(await page.getByRole('button',{name:'Exportar PDF',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Aplicar período',exact:true}).click();await page.getByText('Escolha um período válido',{exact:false}).waitFor();
  mode='error';await page.getByRole('button',{name:'Mês',exact:true}).click();await page.getByText('Não foi possível carregar o relatório.',{exact:false}).waitFor();
  mode='empty';await page.getByRole('button',{name:'Tentar novamente',exact:true}).click();await page.getByText('Nenhuma venda neste recorte',{exact:true}).waitFor();
  mode='normal';costs=false;await page.getByRole('button',{name:'Mês',exact:true}).click();await settled();await page.getByText('Restrita',{exact:true}).waitFor();assert.equal(await page.locator('.rp-table:visible th:visible').count(),3);
  costs=true;await page.getByRole('button',{name:'Mês',exact:true}).click();await settled();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Sem overflow global no celular');
  assert.deepEqual(errors,[]);console.log('PASS: tela, períodos, filtros, concorrência, medidas, itens, paginação, visão salva, custos restritos, CSV completo, PDF, erro, vazio e celular.');
  if(process.argv.includes('--full')){
    const full=await browser.newPage({viewport:{width:1650,height:1580}}),fullErrors=[],expressions=[];
    full.on('pageerror',error=>fullErrors.push(error.message));full.on('console',message=>{if(message.text().includes('Alpine Expression Error'))expressions.push(message.text());});
    await full.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    await full.goto('http://127.0.0.1:'+server.address().port+'/admin/painel?full=1');
    await full.locator('#farejador-sidebar-nav').getByRole('link',{name:'Relatórios',exact:true}).click();
    await full.waitForFunction(()=>Alpine.$data(document.body).rp.data&&!Alpine.$data(document.body).rp.loading);
    assert.equal(await full.locator('.rp-table:visible tbody').count(),4);
    assert.equal(await full.locator('.rp-library-row svg').count(),2);
    await full.evaluate(()=>{const banner=document.createElement('p');banner.textContent='VALIDAÇÃO LOCAL · dados fictícios';banner.style.cssText='padding:8px;background:#fff7dd;color:#806127';document.querySelector('.rp-heading').before(banner);});
    await full.screenshot({path:path.join(out,'painel-completo.png'),fullPage:true});
    await full.setViewportSize({width:390,height:844});await full.screenshot({path:path.join(out,'painel-celular.png'),fullPage:true});
    assert.equal(await full.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    fs.writeFileSync(path.join(out,'painel-completo.json'),JSON.stringify({fullErrors,expressions},null,2));
    assert.equal(expressions.some(value=>/Expression:.*\brp\b|rp\w+ is not defined/.test(value)),false,'Nenhuma falha de expressão do relatório');
    assert.deepEqual([...new Set(fullErrors)].filter(value=>value!=='row is not defined'),[],'Nenhum erro novo no painel completo');
    console.log('PASS: menu e relatório no painel completo; erros já existentes: '+JSON.stringify([...new Set(fullErrors)]));await full.close();
  }
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));const {pool}=await import(pathToFileURL(path.join(root,'dist/persistence/db.js')));await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
