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
const navStart=html.indexOf('      <div class="bot-section-navigation');
const navEnd=html.indexOf('      <section x-show="botTab === \'espera\'"',navStart);
assert(navStart>0&&navEnd>navStart);
const navigation=html.slice(navStart,navEnd);
const heading=html.match(/<header x-show="botTab === 'entrega'" class="bd-heading"[\s\S]*?<\/header>/)?.[0];assert(heading);
const botHostTag=html.match(/<div x-show="currentPage === 'bot'"[^>]+>/)?.[0];assert(botHostTag);
let version=0;
let settings={delivery_enabled:true,pickup_enabled:true,radius_km:null,address:'Matriz · endereço de teste',latitude:-22.8777701,longitude:-42.9900824,
  days:[],opens_at:null,closes_at:null,delivery_days:null,
  freight:{first_limit_km:15,first_price_brl:9.9,second_limit_km:25,second_price_brl:13,above_price_brl:19}};
const boot=`window.deliveryTest=()=>{
 const state={currentPage:'bot',botTab:'entrega',adminUser:{role:'owner'},
 redePeriods:[],botPeriodo:'today',bfOpen(){this.botTab='faltas';},renderBotMapa(){},
 apiGet:async url=>(await fetch(url)).json(),
 apiPost:async(url,body)=>(await fetch(url,{method:'POST',body:JSON.stringify(body)})).json(),
 apiPut:async(url,body)=>(await fetch(url,{method:'PUT',body:JSON.stringify(body)})).json()};
 for(const factory of [PAINEL_MODULES.botEntrega,PAINEL_MODULES.botEntregaMapa])Object.defineProperties(state,Object.getOwnPropertyDescriptors(factory()));
 return state;
};`;
const pageHtml=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/admin/painel/tailwind.css"><link rel="stylesheet" href="/admin/painel/bot-entrega.css">
<style>body{margin:0;background:#f7f9f7;font-family:Arial,sans-serif}.preview-side{position:fixed;inset:0 auto 0 0;width:195px;background:#064b40;color:white;padding:28px 22px}.preview-side b{font-size:40px}.preview-side p{margin-top:34px}.preview-main{margin-left:195px;padding:0}.preview-top{height:84px;padding:12px 12px 8px;background:#f9fafb}.preview-top>div{height:64px;display:flex;align-items:center;gap:20px;padding:0 20px;border-radius:16px;background:#022c22;color:#fff}.preview-top input{flex:1;max-width:500px;border:1px solid #356a59;border-radius:8px;background:#214539;padding:10px;color:#fff}.preview-bot-nav{display:flex;gap:20px;align-items:center;margin:16px 0 20px;padding:8px 0;border-bottom:1px solid #8c9d96;color:#234c3e;font-size:12px}.preview-bot-nav b{border-bottom:2px solid #065f46;padding-bottom:8px}.preview-tag{font-size:10px;color:#9a651a;margin-bottom:8px}[x-cloak]{display:none!important}@media(max-width:650px){.preview-side{display:none}.preview-main{margin:0;padding:0}.preview-top{display:none}}</style>
<script src="/admin/painel/app.bot.entrega.js"></script><script src="/admin/painel/app.bot.entrega.mapa.js"></script><script>${boot}</script>
<script src="/admin/painel/vendor/lucide-1.17.0.min.js"></script><script defer src="/admin/painel/vendor/alpine-3.14.9.min.js"></script></head><body><aside class="preview-side"><b>2W</b><div>P N E U S</div><p>Visão geral</p><p>● Bot</p><p>Vendas</p><p>Compras</p><p>Estoque</p><p>Logística</p><p>Rede</p><p>Financeiro</p></aside><main class="preview-main" x-data="deliveryTest()" x-init="botEntregaCarregar(); lucide.createIcons()"><div class="preview-top"><div><strong>CENTRAL DE REDE</strong><input aria-label="Busca ilustrativa do painel" placeholder="Buscar parceiro, pedido, produto…" disabled><span>Matriz</span></div></div>${botHostTag}<div class="preview-tag">AMBIENTE DE TESTE · sem alteração no banco</div>${heading}${navigation}${section}</div></main></body></html>`;
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
      assert.equal(body.items[0].quantity,2);assert.equal(body.settings.radius_km,55);
      assert.deepEqual(body.settings.freight,{first_limit_km:20,first_price_brl:0,second_limit_km:40,second_price_brl:17.25,above_price_brl:32.5});
      data={selected:'matriz',store:'Matriz',reason:'matriz_closer',freight:0,delivery_days:1,approximate:false,location:{lat:-22.9,lng:-43},
        diagnostics:[{unitId:'matriz',name:'Matriz',distanceKm:5.2,reason:'apt',selected:true},{unitId:'parceiro',name:'Parceiro de teste',distanceKm:8.1,reason:'apt',selected:false}]};
    }
    res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(data));
  }
  const relative=url.pathname.replace('/admin/painel/','');
  const allowed=new Set(['tailwind.css','bot-entrega.css','app.bot.entrega.js','app.bot.entrega.mapa.js','vendor/alpine-3.14.9.min.js','vendor/lucide-1.17.0.min.js','assets/fonts/roboto-latin-v1.woff2','assets/fonts/roboto-condensed-latin-v1.woff2']);
  if(!allowed.has(relative)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',relative.endsWith('.css')?'text/css':relative.endsWith('.woff2')?'font/woff2':'application/javascript');
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
    const nav=page.getByRole('navigation',{name:'Seções do Bot'});
    assert.equal(await nav.getByRole('button').count(),7);
    assert.equal(await nav.getByRole('button',{name:'Entrega e cobertura',exact:true}).getAttribute('aria-current'),'page');
    const menu=await nav.evaluate(el=>Array.from(el.querySelectorAll('button')).map(button=>({height:button.getBoundingClientRect().height,top:button.getBoundingClientRect().top,icon:getComputedStyle(button.querySelector('svg')).display})));
    assert(menu.every(button=>button.height>=40&&button.height<=44&&button.icon!=='none'));assert.equal(new Set(menu.map(button=>button.top)).size,1);
    assert(await page.locator('#bot-delivery-heading').evaluate(el=>el.getBoundingClientRect().bottom<document.querySelector('.bot-section-nav').getBoundingClientRect().top));
    const statusLights=page.locator('.bd-status-strip .bd-status-light');assert.equal(await statusLights.count(),2);
    assert.equal(await statusLights.nth(1).evaluate(el=>el.classList.contains('bd-off')),false);
    await page.getByLabel('Permitir retirada na loja',{exact:true}).uncheck();
    await page.getByText('Retirada desabilitada',{exact:true}).waitFor();
    assert.equal(await statusLights.nth(1).evaluate(el=>el.classList.contains('bd-off')),true);
    await page.getByLabel('Permitir retirada na loja',{exact:true}).check();
    await page.getByText('Retirada liberada',{exact:true}).waitFor();
    assert.equal(await statusLights.nth(1).evaluate(el=>el.classList.contains('bd-off')),false);
    await nav.getByRole('button',{name:'Conversas',exact:true}).focus();await page.keyboard.press('Enter');
    assert.equal(await nav.getByRole('button',{name:'Conversas',exact:true}).getAttribute('aria-current'),'page');
    assert.equal(await page.locator('.bot-delivery-page').count(),0);
    await nav.getByRole('button',{name:'Entrega e cobertura',exact:true}).click();await page.locator('#bd-radius').waitFor();
    assert.equal(await page.locator('#bd-radius').getAttribute('max'),'55');
    assert.equal(await page.getByRole('slider').getAttribute('max'),'55');
    await page.locator('#bd-radius').fill('56');
    await page.getByRole('button',{name:'Salvar alterações',exact:false}).click();
    await page.getByText('Informe um limite de entrega maior que zero e de até 55 km.',{exact:true}).waitFor();
    assert.equal(version,0);
    await page.locator('#bd-radius').fill('55');
    assert.equal(await page.getByLabel('Valor da primeira faixa',{exact:true}).inputValue(),'9,90');
    await page.getByLabel('Limite da primeira faixa em km').fill('20');
    await page.getByLabel('Limite da segunda faixa em km').fill('15');
    await page.getByRole('button',{name:'Salvar alterações',exact:false}).click();
    await page.getByText('Informe faixas de distância crescentes', {exact:false}).waitFor();
    assert.equal(version,0);
    await page.getByLabel('Limite da segunda faixa em km').fill('40');
    await page.getByText('Acima de 40 km',{exact:true}).waitFor();
    await page.getByLabel('Valor da primeira faixa',{exact:true}).fill('');
    await page.getByRole('button',{name:'Salvar alterações',exact:false}).click();
    await page.getByText('Preencha todos os valores de frete', {exact:false}).waitFor();
    assert.equal(version,0);
    await page.getByLabel('Valor da primeira faixa',{exact:true}).fill('0,00');
    await page.getByLabel('Valor da segunda faixa',{exact:true}).fill('17,25');
    await page.getByLabel('Valor acima da segunda faixa',{exact:true}).fill('32,50');
    await page.getByRole('button',{name:'Seg',exact:true}).click();
    await page.getByRole('button',{name:'Ter',exact:true}).click();
    await page.locator('#bd-prazo').selectOption('1');
    await page.getByRole('button',{name:'Salvar alterações',exact:false}).click();
    await page.getByText('Configuração salva. O bot já usa', {exact:false}).waitFor();
    assert.equal(version,1);assert.equal(settings.radius_km,55);
    assert.equal(settings.freight.first_price_brl,0);assert.equal(settings.freight.second_price_brl,17.25);assert.equal(settings.freight.above_price_brl,32.5);
    await page.reload();
    await page.getByText('● Configuração salva',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Valor acima da segunda faixa',{exact:true}).inputValue(),'32,50');
    await page.getByRole('button',{name:'Ⅱ Pausar entregas',exact:false}).click();
    assert.equal(await page.getByLabel('Entregar pela Matriz',{exact:true}).isChecked(),false);
    assert.equal(await page.getByLabel('Permitir retirada na loja',{exact:true}).isChecked(),true);
    await page.getByRole('button',{name:'▶ Retomar entregas',exact:false}).click();
    await page.locator('#bd-customer-address').fill('Endereço de teste, São Gonçalo');
    await page.getByRole('button',{name:'Selecionar pneus',exact:false}).click();
    await page.locator('#bd-products').fill('130');
    await page.getByRole('button',{name:'Pneu 130/70-13',exact:false}).click();
    await page.getByRole('spinbutton',{name:'Quantidade de Pneu 130/70-13'}).fill('2');
    await page.getByRole('button',{name:'Concluir seleção',exact:true}).click();
    await page.getByRole('button',{name:'Simular',exact:true}).click();
    await page.getByRole('heading',{name:'Matriz atende',exact:true}).waitFor();
    await page.getByRole('button',{name:'Ver opções de lojas',exact:false}).click();
    await page.locator('#bd-diagnostics').waitFor();
    await page.getByRole('button',{name:'Ver opções de lojas',exact:false}).click();
    await page.locator('#bd-diagnostics').waitFor({state:'hidden'});
    const beforeDiscard=version;
    await page.locator('#bd-radius').fill('54');
    await page.getByRole('button',{name:'Descartar',exact:true}).click();
    assert.equal(await page.locator('#bd-radius').inputValue(),'55');
    assert.equal(version,beforeDiscard);
    assert.equal(await page.locator('.bd-card .bd-screws>i').count(),16);
    await page.evaluate(()=>document.fonts.ready);
    assert.deepEqual(errors,[]);
    const output=path.join(root,'artifacts','bot-entrega');fs.mkdirSync(output,{recursive:true});

    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});
    await page.locator('.bot-delivery-page').screenshot({path:path.join(output,'menu-estampado-aplicado.png')});
    const card=page.locator('.bd-card').filter({has:page.getByRole('heading',{name:'Horários e frete',exact:true})});
    await card.screenshot({path:path.join(output,'regras-frete-editavel.png')});
    await page.getByLabel('Valor acima da segunda faixa',{exact:true}).fill('33,00');
    await page.getByText('Você alterou os dados.',{exact:false}).waitFor();
    // Painel lateral: rascunho, cancelamento, validação, cópia, foco e persistência.
    const savedBeforeHours=version;
    await page.getByRole('button',{name:'Ajustar por dia',exact:true}).click();
    const drawer=page.getByRole('dialog',{name:'Horários da loja'});
    await drawer.waitFor();
    await page.getByRole('switch',{name:'Segunda: loja aberta',exact:true}).check();
    await page.getByLabel('Abertura: Segunda',{exact:true}).fill('08:00');
    await page.getByLabel('Fechamento: Segunda',{exact:true}).fill('18:00');
    await page.getByRole('button',{name:'Cancelar',exact:true}).click();
    await page.getByRole('button',{name:'Ajustar por dia',exact:true}).click();
    assert.equal(await page.getByRole('switch',{name:'Segunda: loja aberta',exact:true}).isChecked(),false);
    await page.getByRole('switch',{name:'Segunda: loja aberta',exact:true}).check();
    await page.getByLabel('Abertura: Segunda',{exact:true}).fill('18:00');
    await page.getByLabel('Fechamento: Segunda',{exact:true}).fill('08:00');
    await page.getByRole('button',{name:'Aplicar horários',exact:true}).click();
    await drawer.getByRole('alert').filter({hasText:'Segunda:'}).waitFor();
    await page.getByLabel('Abertura: Segunda',{exact:true}).fill('08:00');
    await page.getByLabel('Fechamento: Segunda',{exact:true}).fill('18:00');
    await page.getByRole('button',{name:'Copiar segunda para terça a sexta',exact:true}).click();
    assert.equal(await page.getByLabel('Abertura: Sexta',{exact:true}).inputValue(),'08:00');
    await page.getByRole('switch',{name:'Sábado: loja aberta',exact:true}).check();
    await page.getByLabel('Abertura: Sábado',{exact:true}).fill('08:00');
    await page.getByLabel('Fechamento: Sábado',{exact:true}).fill('14:00');
    assert.equal(await page.getByLabel('Abertura: Domingo',{exact:true}).isDisabled(),true);
    await page.screenshot({path:path.join(output,'horarios-lateral-desktop.png'),fullPage:false});
    await page.getByRole('button',{name:'Aplicar horários',exact:true}).click();
    assert.equal(version,savedBeforeHours);
    await page.getByRole('button',{name:'Salvar alterações',exact:false}).click();
    await page.getByText('Configuração salva. O bot já usa', {exact:false}).waitFor();
    assert.equal(settings.store_hours.length,6);
    assert.equal(settings.store_hours.find(d=>d.day===6).closes_at,'14:00');
    await page.getByRole('button',{name:'Ajustar por dia',exact:true}).click();
    await page.keyboard.press('Escape');
    assert.equal(await drawer.isVisible(),false);
    assert.equal(await page.getByRole('button',{name:'Ajustar por dia',exact:true}).evaluate(el=>el===document.activeElement),true);
    // A área metálica preenche a página inteira, inclusive em monitor largo.
    await page.setViewportSize({width:2560,height:1440});
    const area=await page.evaluate(()=>{const host=document.querySelector('.bot-delivery-page');const content=document.querySelector('section.bot-delivery');const main=document.querySelector('.preview-main');const h=host.getBoundingClientRect(),c=content.getBoundingClientRect(),m=main.getBoundingClientRect(),style=getComputedStyle(host);return {hostWidth:h.width,mainWidth:m.width,contentWidth:c.width,expectedContent:h.width-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),hostHeight:h.height,viewport:innerHeight,border:getComputedStyle(content).borderTopWidth,metal:style.backgroundImage!=='none',overflow:document.documentElement.scrollWidth>innerWidth};});
    assert.equal(area.hostWidth,area.mainWidth);assert(Math.abs(area.contentWidth-area.expectedContent)<1);assert(area.hostHeight>=area.viewport-84);assert.equal(area.border,'0px');assert.equal(area.metal,true);assert.equal(area.overflow,false);
    await page.screenshot({path:path.join(output,'desktop-area-inteira.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.getByRole('button',{name:'Ajustar por dia',exact:true}).click();
    await page.screenshot({path:path.join(output,'horarios-lateral-mobile.png'),fullPage:false});
    assert.equal(await drawer.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    await page.getByRole('button',{name:'Fechar horários',exact:true}).click();
    assert.deepEqual(errors,[]);
    console.log('OK: raio até 55 km, faixas editáveis, valores em reais, validação, salvamento/releitura, pausa/retirada, simulação, frete alterado invalida resultado e layout móvel, menu compacto e luz de retirada. Capturas: '+output);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
