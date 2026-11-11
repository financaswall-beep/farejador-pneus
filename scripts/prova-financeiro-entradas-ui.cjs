// Formulário e módulo reais com API local fictícia; não registra dinheiro real.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const pub=path.resolve(__dirname,'../painel/public'),src=fs.readFileSync(path.join(pub,'index.html'),'utf8');
const marker='<button x-show="adminUser?.role === \'owner\'" @click="finEntradaAbrir()"';
const a=src.indexOf(marker),b=src.indexOf('<dialog id="fin-entry-dialog"');assert(a>0&&b>0);
const button=src.slice(a,src.indexOf('</button>',a)+9),dialog=src.slice(b,src.indexOf('</dialog>',b)+9);
const id='10000000-0000-4000-8000-000000000001',requests=[];
const html=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/admin/painel/tailwind.css"><link rel="stylesheet" href="/admin/painel/financeiro-visao.css">
<style>[x-cloak]{display:none!important}body{font-family:Inter,system-ui,sans-serif;background:#f6f8fa}.proof{padding:24px}.proof h1{font-size:30px;font-weight:700}.proof small{color:#65738a}.proof p{margin:16px 0}</style>
<script src="/admin/painel/app.financeiro.entradas.js"></script>
<script>window.proof=()=>Object.assign(PAINEL_MODULES.financeiroEntradas(),{adminUser:{role:'owner'},finMes:'2026-11',finExtratoFiltro:{mes:'2026-11',base:'caixa'},
finHoje:()=> '2026-11-11',businessFactInstant:d=>d+'T12:00:00-03:00',loadFinanceiro:async()=>{},loadFinExtrato:async()=>{},
apiPost:async(u,b)=>{const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const data=await r.json();if(!r.ok)throw Error(data.error);return data}})</script>
<script defer src="/admin/painel/vendor/alpine-3.14.9.min.js"></script></head>
<body><main class="finance-page proof" x-data="proof()"><small>VALIDAÇÃO LOCAL · DADOS FICTÍCIOS</small><h1>Financeiro</h1><p>Entradas recebidas e patrimônio separados.</p>${button}
<button class="fv-button" @click="finEntradaAbrir({id:'${id}',description:'Receita avulsa de exemplo',cash_on:'2026-11-01'})">Estornar entrada</button>
<p role="status" x-text="finEntradaAviso"></p>${dialog}</main></body></html>`;
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);}
  if(u.pathname.startsWith('/admin/api/')){let raw='';for await(const data of req)raw+=data;
    requests.push({url:u.pathname,body:JSON.parse(raw)});res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({id}));}
  const file=path.resolve(pub,u.pathname.replace('/admin/painel/',''));
  if(!file.startsWith(pub+path.sep)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,channel:'msedge'});
  const out=path.resolve(__dirname,'../artifacts/financeiro-entradas-20261111');fs.mkdirSync(out,{recursive:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
    await page.goto('http://127.0.0.1:'+server.address().port);await page.getByRole('button',{name:'Nova entrada',exact:true}).click();
    await page.locator('#fin-entry-dialog[open]').waitFor();
    await page.locator('#fin-entry-amount').fill('1.250,50');await page.locator('#fin-entry-reason').fill('Serviço avulso recebido');
    assert.equal(await page.locator('#fin-entry-amount').inputValue(),'1.250,50');
    await page.screenshot({path:path.join(out,'receita-desktop.png'),fullPage:true});
    await page.getByRole('button',{name:'Registrar entrada',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('dialog').open);
    assert.equal(requests[0].body.amount,1250.5);assert.equal(requests[0].body.kind,'income');assert.equal(requests[0].body.category,'servicos');
    await page.getByRole('button',{name:'Nova entrada',exact:true}).click();await page.locator('#fin-entry-kind').selectOption('owner_contribution');
    await page.locator('#fin-entry-category').waitFor({state:'hidden'});
    assert.match(await page.locator('#fin-entry-dialog').innerText(),/sem contar como receita ou lucro/);
    await page.locator('#fin-entry-amount').fill('500');await page.locator('#fin-entry-reason').fill('Capital colocado pelo proprietário');
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'aporte-mobile.png'),fullPage:true});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert(await page.locator('#fin-entry-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth));
    await page.getByRole('button',{name:'Registrar entrada',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('dialog').open);
    assert.equal(requests[1].body.kind,'owner_contribution');assert(!('category'in requests[1].body));
    await page.getByRole('button',{name:'Estornar entrada',exact:true}).click();
    await page.locator('#fin-entry-amount').waitFor({state:'hidden'});
    await page.locator('#fin-entry-reason').fill('Registro em duplicidade');
    await page.getByRole('button',{name:'Confirmar estorno',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('dialog').open);
    assert(requests[2].url.endsWith('/'+id+'/reverse'));assert.equal(requests[2].body.reason,'Registro em duplicidade');
    await page.getByRole('button',{name:'Nova entrada',exact:true}).click();await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog[open]').count(),0);assert.deepEqual(errors,[]);
    console.log('OK: receita, aporte, máscaras, confirmação, estorno e Escape; desktop/mobile sem overflow ou erros JS.');
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
