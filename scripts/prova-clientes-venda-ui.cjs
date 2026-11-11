// HTML e Alpine reais, APIs fictícias locais. Não acessa produção.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const pub=path.resolve(__dirname,'../painel/public'),out=path.resolve('.codex-tmp/sale-customer-proof');
const source=fs.readFileSync(path.join(pub,'index.html'),'utf8');
const start=source.indexOf('<div x-show="saleModalOpen &&'),end=source.indexOf('<!-- Modal acessível de Compras:',start);
assert(start>0&&end>start);
const product={product_id:'11111111-1111-4111-8111-111111111111',product_name:'Pneu de prova',walkin_sellable:true,price_amount:120,official_unit_cost:40,total_stock_available:10};
const customer={id:'22222222-2222-4222-8222-222222222222',source:'balcao',name:'Maria da Silva',phone:'+5521999998888'};
let submitted=[];
const html=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/admin/painel/tailwind.css"><style>[x-cloak]{display:none!important}</style>
<script src="/admin/painel/app.format.js"></script><script src="/admin/painel/app.venda.modal.js"></script><script src="/admin/painel/app.pedidos.parceiros.js"></script>
<script>window.proof=()=>({...PAINEL_MODULES.format(),...PAINEL_MODULES.vendaModal(),...PAINEL_MODULES.pedidosParceiros(),adminUser:{role:'owner'},produtos:[],saleForm:{},saleModalOpen:false,orderSubmitting:false,orderError:null,operatorLabel:'Prova local',modalConv:null,
saleVehicleType:'all',saleVehicleChanged:()=>{},saleVehicleProducts:[${JSON.stringify(product)}],vehicleTypeLabel:()=> 'Moto',
applyProdutos(rows){this.produtos=rows},loadRealData:async()=>{},loadFinanceiro:async()=>{},loadVarejoResumo:async()=>{},
apiGet:async u=>{const r=await fetch(u);if(!r.ok)throw Error('failed');return r.json()},apiPost:async(u,b)=>{const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});return r.json()}})</script>
<script defer src="/admin/painel/vendor/alpine-3.14.9.min.js"></script></head><body><main x-data="proof()"><button @click="openWalkinModal()">Abrir venda</button>${source.slice(start,end)}</main></body></html>`;
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/'){res.setHeader('Content-Type','text/html');return res.end(html);}
  if(u.pathname.startsWith('/admin/api/')){
    res.setHeader('Content-Type','application/json');
    if(req.method==='POST'){let body='';for await(const part of req)body+=part;submitted.push(JSON.parse(body));return res.end('{"order_id":"proof"}');}
    return res.end(JSON.stringify(u.pathname.includes('customer-search')?{rows:[customer]}:u.pathname.includes('/ficha')?
      {customer:{address:'Rua anterior, 10'},summary:{purchases:2,total_spent:240}}:{rows:[product]}));
  }
  const file=path.resolve(pub,u.pathname.replace('/admin/painel/',''));
  if(!file.startsWith(pub+path.sep)||!fs.existsSync(file)||!/\.(js|css)$/.test(file)){res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(file));
});
(async()=>{
  fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:960}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.getByRole('button',{name:'Abrir venda',exact:true}).click();
    await page.getByRole('button',{name:'Confirmar venda',exact:true}).click();
    await page.getByText('Busque e selecione um cliente.',{exact:true}).waitFor();assert.equal(submitted.length,0);
    await page.getByRole('searchbox').fill('Maria');
    await page.getByRole('button',{name:/Maria da Silva/}).click();
    await page.getByText(/2 compras concluídas/).waitFor();
    const price=page.getByRole('spinbutton',{name:'Preço vendido (un.) · R$'});
    assert(await price.isEditable());assert.equal(await price.inputValue(),'120');
    await price.fill('150.50');await page.getByRole('spinbutton').first().fill('2');
    assert.match(await page.locator('[x-text="saleTotal()"]').innerText(),/301,00/);
    assert.match(await page.getByText('Lucro bruto estimado',{exact:true}).locator('..').innerText(),/221,00/);
    await page.screenshot({path:path.join(out,'existente.png'),fullPage:true});
    await page.getByRole('button',{name:'Confirmar venda',exact:true}).click();
    await page.waitForFunction(()=>!Alpine.$data(document.querySelector('main')).saleModalOpen);
    assert.deepEqual(submitted[0].customer_ref,{source:'balcao',id:customer.id});assert.equal(submitted[0].customer_name,null);
    assert.equal(submitted[0].items[0].unit_price,150.5);assert.equal(submitted[0].items[0].reference_unit_price,120);
    await page.getByRole('button',{name:'Abrir venda',exact:true}).click();
    await page.locator('[x-model="saleCustomer.mode"]').selectOption('new');
    await page.getByRole('textbox',{name:'Nome do cliente',exact:true}).fill('  João   de Sá  ');
    const phone=page.getByRole('textbox',{name:'Telefone (opcional)',exact:true});await phone.fill('+5521988887777');
    assert.equal(await phone.inputValue(),'(21) 98888-7777');
    await page.locator('[x-model="saleForm.fulfillment_mode"]').selectOption('delivery');
    await page.getByRole('textbox',{name:'CEP (opcional)',exact:true}).fill('24000123');
    assert.equal(await page.getByRole('textbox',{name:'CEP (opcional)',exact:true}).inputValue(),'24000-123');
    await page.getByRole('textbox',{name:'Rua',exact:true}).fill('Rua Um');
    await page.getByRole('checkbox',{name:'Sem número',exact:true}).check();
    await page.getByRole('textbox',{name:'Bairro',exact:true}).fill('Centro');
    await page.getByRole('textbox',{name:'Cidade',exact:true}).fill('Niterói');
    await page.getByRole('combobox',{name:'UF',exact:true}).selectOption('RJ');
    await page.setViewportSize({width:390,height:844});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});
    await page.getByRole('button',{name:'Confirmar venda',exact:true}).click();
    await page.waitForFunction(()=>!Alpine.$data(document.querySelector('main')).saleModalOpen);
    assert.equal(submitted.length,2);assert.equal(submitted[1].customer_name,'João de Sá');
    assert.equal(submitted[1].delivery_address_fields.no_number,true);assert.equal(submitted[1].customer_mode,'new');
    assert.deepEqual(errors,[]);console.log('OK: preço humano editável, total/lucro pelo valor vendido, referência preservada; busca, cadastro e mobile sem overflow.');
  }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
