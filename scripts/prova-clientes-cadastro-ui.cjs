// HTML/CSS/módulos reais, servidor exclusivamente local e cadastros fictícios.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const pub=path.resolve(__dirname,'../painel/public'),html=fs.readFileSync(path.join(pub,'index.html'),'utf8');
const start=html.indexOf('<header class="cc-header"'),end=html.indexOf('<!-- 2. LEADS',start);
const content=html.slice(start,html.indexOf('<div x-show="clientesLoading"',start))
  +html.slice(html.indexOf('<!-- 1. TODOS -->',start),end);
const dialog=html.slice(html.indexOf('<dialog x-ref="clienteCadastroDialog"'),html.indexOf('</dialog>',html.indexOf('<dialog x-ref="clienteCadastroDialog"'))+9);
assert(start>0&&end>start&&dialog);
const id='10000000-0000-4000-8000-000000000001';
const rows=[{id:'chatwoot:'+id,source:'chatwoot',source_id:id,name:'João Ferreira',phone:'+5521999994321',kind:'pessoa_fisica',origin:'WhatsApp',purchases:3,total_spent:1240},
  {id:'atacado:'+id,source:'atacado',source_id:id,name:'Borracharia do Zé',phone:'2125488825',kind:'borracharia',origin:'WhatsApp',purchases:12,total_spent:18450},
  {id:'balcao:'+id,source:'balcao',source_id:id,name:'Ana Costa',phone:'2548825',kind:'nao_classificado',origin:'Balcão',purchases:0,total_spent:0}]
  .map(c=>({...c,status:'ativo',email:null,is_vip:c.purchases>=3,last_purchase_at:null,lead_interests:[]}));
let lastWrite=null,invalid=false;
const scripts=['customer-fields.js','app.clientes.cadastro.js','app.clientes.js'];
const pageHtml=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/admin/painel/tailwind.css"><link rel="stylesheet" href="/admin/painel/clientes-cadastro.css">
<style>body{font-family:Inter,system-ui,sans-serif;background:#f8fafb}[x-cloak]{display:none!important}.proof-note{font-size:11px;color:#65738a;padding:12px 24px}</style>
${scripts.map(s=>`<script src="/admin/painel/${s}"></script>`).join('')}
<script>window.proof=()=>Object.assign({clientes:${JSON.stringify(rows)},clientesTab:'todos',clientesBusca:'',clientesTipo:'todos',clientesOrigem:'todos',clientesStatus:'todos',clientesClasse:'todos',clientesPeriodo:'todos',clientesPagina:1,clientesPorPagina:8,clienteSelecionadoId:null,
adminAuthenticated:true,currentPage:'clientes',adminUser:{role:'owner'},customerIdentityEnabled:false,apiHeaders:()=>({}),
apiGet:async u=>(await fetch(u)).json(),
initials:n=>n.split(' ').map(s=>s[0]).slice(0,2).join(''),formatCurrency:n=>Number(n).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}),
clienteData:v=>v||'—',carregarClienteLeadFoto(){},clienteLeadFoto(){return ''},clienteLeadFotoFalhou(){},clienteOrigemIcone(){return ''},abrirFichaCliente(c){this.abrirCadastroCliente(c)},
clienteOrigemLabel:s=>s,registrarBotControle(){},loadCustomerIdentities(){},clientesParceiros:[],customerIdentityRows:[],
loadClientes:async()=>{},
},PAINEL_MODULES.clientes(),PAINEL_MODULES.clientesCadastro(),{customerRegistryEnabled:true,loadClientes:async()=>{}})</script>
<script src="/admin/painel/vendor/lucide-1.17.0.min.js"></script><script defer src="/admin/painel/vendor/alpine-3.14.9.min.js"></script>
</head><body><main x-data="proof()" x-init="lucide.createIcons()"><p class="proof-note">VALIDAÇÃO LOCAL · DADOS FICTÍCIOS</p><div class="cc-screen min-h-screen p-4 lg:p-5">${content}</div>${dialog}</main></body></html>`;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(pageHtml);}
  if(url.pathname.startsWith('/admin/api/')){
    res.setHeader('Content-Type','application/json');
    if(req.method==='POST'||req.method==='PUT'){
      let data='';for await(const chunk of req)data+=chunk;lastWrite=JSON.parse(data);
      if(invalid){res.statusCode=400;return res.end(JSON.stringify({error:'invalid_customer',fields:{phone:['Informe telefone completo com DDD.']}}));}
      return res.end(JSON.stringify({source:'balcao',source_id:id}));
    }
    const source=url.pathname.split('/')[4];const c=rows.find(c=>c.source===source)||rows[0];
    return res.end(JSON.stringify({customer:{...c,registry:null},orders:[],summary:{purchases:c.purchases},next_offset:null}));
  }
  const file=path.resolve(pub,url.pathname.replace('/admin/painel/',''));
  if(!file.startsWith(pub+path.sep)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':'application/javascript');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'msedge'});
  const out=path.resolve(__dirname,'../artifacts/clientes-cadastro-20261110');fs.mkdirSync(out,{recursive:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:980}}),errors=[];
    page.on('pageerror',error=>{errors.push(error.message);console.error('UI:',error.message);});
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.locator('.cc-list tbody tr').first().waitFor();
    assert.equal(await page.locator('.cc-list tbody tr').count(),3);
    assert.match(await page.locator('.cc-list').innerText(),/\(21\) 99999-4321/);
    assert.match(await page.locator('.cc-list').innerText(),/2548825/);
    assert.equal(await page.locator('.cc-header img').count(),0);
    await page.screenshot({path:path.join(out,'desktop.png'),fullPage:true});
    await page.getByRole('group',{name:'Perfil comercial'}).getByRole('button',{name:'Atacado',exact:true}).click();
    assert.equal(await page.locator('.cc-list tbody tr').count(),1);
    assert.match(await page.locator('.cc-list tbody').innerText(),/Borracharia/);
    await page.getByRole('group',{name:'Perfil comercial'}).getByRole('button',{name:'Todos',exact:true}).click();
    await page.getByPlaceholder('Buscar cliente ou telefone').fill('(21) 99999');
    await page.waitForFunction(()=>document.querySelectorAll('.cc-list tbody tr').length===1);
    assert.equal(await page.locator('.cc-list tbody tr').count(),1);
    await page.getByPlaceholder('Buscar cliente ou telefone').fill('');
    await page.waitForFunction(()=>document.querySelectorAll('.cc-list tbody tr').length===3);
    await page.getByRole('button',{name:'Novo cliente',exact:true}).click();
    await page.locator('dialog[open]').waitFor();
    await page.locator('#cliente-cadastro-nome').fill('Maria  da Silva');
    await page.locator('#cliente-cadastro-telefone').fill('21999994321');
    assert.equal(await page.locator('#cliente-cadastro-telefone').inputValue(),'(21) 99999-4321');
    await page.locator('#cliente-cadastro-documento').fill('52998224725');
    assert.equal(await page.locator('#cliente-cadastro-documento').inputValue(),'529.982.247-25');
    await page.locator('#cliente-cadastro-cep').fill('24400000');
    assert.equal(await page.locator('#cliente-cadastro-cep').inputValue(),'24400-000');
    await page.locator('#cliente-cadastro-perfil').selectOption('varejo');
    await page.screenshot({path:path.join(out,'cadastro-desktop.png'),fullPage:true});
    invalid=true;await page.locator('#cliente-cadastro-telefone').fill('2548825');
    await page.getByRole('button',{name:'Salvar cadastro',exact:true}).click();
    await page.locator('.cc-error-banner:visible').waitFor();
    assert.equal(await page.locator('#cliente-cadastro-telefone').getAttribute('aria-invalid'),'true');
    invalid=false;await page.locator('#cliente-cadastro-telefone').fill('21999994321');
    await page.getByRole('button',{name:'Salvar cadastro',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('dialog').open);
    assert.equal(lastWrite.commercial_profile,'varejo');
    await page.getByRole('button',{name:'Perfil comercial de Borracharia do Zé'}).click();
    await page.waitForFunction(()=>document.querySelector('#cliente-cadastro-nome').value==='Borracharia do Zé');
    assert.equal(await page.locator('#cliente-cadastro-perfil').inputValue(),'atacado');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog[open]').count(),0);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});
    await page.getByRole('button',{name:'Novo cliente',exact:true}).click();
    await page.screenshot({path:path.join(out,'cadastro-mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.querySelector('dialog').scrollWidth>document.querySelector('dialog').clientWidth),false);
    assert.deepEqual(errors,[]);
    console.log('OK: filtros, busca com máscara, cadastro, validação, edição e Escape; desktop/mobile sem overflow nem erros JS. Capturas: '+out);
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
