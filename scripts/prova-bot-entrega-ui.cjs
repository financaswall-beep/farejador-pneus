// Exercita a tela real em um navegador com APIs de teste. Nunca conecta ao banco.
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'painel/public/index.html'),'utf8');
const start=html.indexOf('<section x-show="botTab === \'entrega\'"');
const end=html.indexOf('<!-- VISÃO GERAL: cockpit leve do Bot -->',start);
assert(start>0&&end>start);
const section=html.slice(start,end);
let version=0;
let settings={delivery_enabled:true,pickup_enabled:true,radius_km:null,address:'Matriz · endereço de teste',latitude:-22.8777701,longitude:-42.9900824,
  days:[],opens_at:null,closes_at:null,delivery_days:null};
const boot=`window.deliveryTest=()=>{
 const state={botTab:'entrega',adminUser:{role:'owner'},
 apiGet:async url=>(await fetch(url)).json(),
 apiPost:async(url,body)=>(await fetch(url,{method:'POST',body:JSON.stringify(body)})).json(),
 apiPut:async(url,body)=>(await fetch(url,{method:'PUT',body:JSON.stringify(body)})).json()};
 for(const factory of [PAINEL_MODULES.botEntrega,PAINEL_MODULES.botEntregaMapa])Object.defineProperties(state,Object.getOwnPropertyDescriptors(factory()));
 return state;
};`;
const pageHtml=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/admin/painel/tailwind.css"><link rel="stylesheet" href="/admin/painel/bot-entrega.css">
<style>body{margin:0;background:#f7f9f7;font-family:Arial,sans-serif}.preview-side{position:fixed;inset:0 auto 0 0;width:195px;background:#064b40;color:white;padding:28px 22px}.preview-side b{font-size:40px}.preview-side p{margin-top:34px}.preview-main{margin-left:195px;padding:20px 28px}.preview-tag{font-size:10px;color:#9a651a;margin-bottom:8px}[x-cloak]{display:none!important}@media(max-width:650px){.preview-side{display:none}.preview-main{margin:0;padding:14px}}</style>
<script src="/admin/painel/app.bot.entrega.js"></script><script src="/admin/painel/app.bot.entrega.mapa.js"></script><script>${boot}</script>
<script src="/admin/painel/vendor/lucide-1.17.0.min.js"></script><script defer src="/admin/painel/vendor/alpine-3.14.9.min.js"></script></head><body><aside class="preview-side"><b>2W</b><div>P N E U S</div><p>Visão geral</p><p>● Bot</p><p>Vendas</p><p>Compras</p><p>Estoque</p><p>Logística</p><p>Rede</p><p>Financeiro</p></aside><main class="preview-main" x-data="deliveryTest()" x-init="botEntregaCarregar(); lucide.createIcons()"><div class="preview-tag">AMBIENTE DE TESTE · sem alteração no banco</div>${section}</main></body></html>`;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(pageHtml);}
  if(url.pathname.startsWith('/admin/api/')){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
    let data={};
    if(url.pathname==='/admin/api/bot/entrega'){
      if(req.method==='PUT'){assert.equal(body.expected_version,version);settings=body.settings;version++;}
      data={configured:version>0,version,settings,updated_at:new Date().toISOString(),maps_browser_key:null,routing:{matriz_competes:true}};
    }else if(url.pathname.endsWith('/produtos'))data={products:[{id:'11111111-1111-4111-8111-111111111111',product_name:'Pneu 130/70-13',brand:'Marca teste',tire_size:'130/70-13'}]};
    else if(url.pathname.endsWith('/simular')){
      assert.equal(body.items[0].quantity,2);assert.equal(body.settings.radius_km,12);
      data={selected:'matriz',store:'Matriz',reason:'matriz_closer',freight:9.9,delivery_days:1,approximate:false,location:{lat:-22.9,lng:-43},
        diagnostics:[{unitId:'matriz',name:'Matriz',distanceKm:5.2,reason:'apt',selected:true},{unitId:'parceiro',name:'Parceiro de teste',distanceKm:8.1,reason:'apt',selected:false}]};
    }
    res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(data));
  }
  const relative=url.pathname.replace('/admin/painel/','');
  const allowed=new Set(['tailwind.css','bot-entrega.css','app.bot.entrega.js','app.bot.entrega.mapa.js','vendor/alpine-3.14.9.min.js','vendor/lucide-1.17.0.min.js']);
  if(!allowed.has(relative)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',relative.endsWith('.css')?'text/css':'application/javascript');
  res.end(fs.readFileSync(path.join(root,'painel/public',relative)));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
  try{
    const page=await browser.newPage({viewport:{width:1512,height:1080}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.getByText('As regras atuais continuam valendo', {exact:false}).waitFor();
    await page.locator('#bd-radius').fill('12');
    await page.getByRole('button',{name:'Seg',exact:true}).click();
    await page.getByRole('button',{name:'Ter',exact:true}).click();
    await page.locator('#bd-prazo').selectOption('1');
    await page.getByRole('button',{name:'Salvar alterações',exact:false}).click();
    await page.getByText('Configuração salva. O bot já usa', {exact:false}).waitFor();
    assert.equal(version,1);assert.equal(settings.radius_km,12);
    await page.getByRole('button',{name:'Pausar entregas da Matriz',exact:false}).click();
    assert.equal(await page.getByLabel('Entregar pela Matriz',{exact:true}).isChecked(),false);
    assert.equal(await page.getByLabel('Permitir retirada na loja',{exact:true}).isChecked(),true);
    await page.getByRole('button',{name:'Retomar entregas da Matriz',exact:false}).click();
    await page.locator('#bd-customer-address').fill('Endereço de teste, São Gonçalo');
    await page.locator('#bd-products').fill('130');
    await page.getByRole('button',{name:'Pneu 130/70-13',exact:false}).click();
    await page.getByRole('spinbutton',{name:'Quantidade de Pneu 130/70-13'}).fill('2');
    await page.getByRole('button',{name:'Simular',exact:true}).click();
    await page.getByRole('heading',{name:'Matriz atende esse endereço'}).waitFor();
    assert.deepEqual(errors,[]);
    const output=path.join(root,'artifacts','bot-entrega');fs.mkdirSync(output,{recursive:true});
    assert((await page.getByRole('spinbutton',{name:'Quantidade de Pneu 130/70-13'}).boundingBox()).width<80);
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});
    await page.getByRole('spinbutton',{name:'Quantidade de Pneu 130/70-13'}).fill('3');
    await page.getByText('Você alterou os dados.',{exact:false}).waitFor();
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    assert.deepEqual(errors,[]);
    console.log('OK: cadastro, salvamento, pausa/retirada, simulação, resultado desatualizado e layout móvel. Capturas: '+output);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
