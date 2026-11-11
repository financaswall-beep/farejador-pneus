import {createContext,runInContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {describe,expect,it,vi} from 'vitest';
import {registerWalkinOrderSchema,registerManualOrderSchema} from '../../../src/admin/painel/route-schemas-orders.js';
const id='10000000-0000-4000-8000-000000000001';
const request=(price=150.5,reference=120)=>({items:[{product_id:id,quantity:2,unit_price:price,reference_unit_price:reference}],
  payment_method:'Pix',fulfillment_mode:'pickup',source_tag:'walkin_balcao',idempotency_key:'walkin-negotiated'});
function ui(){
  const context=createContext({window:{PAINEL_MODULES:{}},crypto,Error});
  for(const file of ['app.format.js','app.venda.modal.js','app.pedidos.parceiros.js'])
    runInContext(readFileSync('painel/public/'+file,'utf8'),context);
  const app=runInContext('Object.assign({},window.PAINEL_MODULES.format(),window.PAINEL_MODULES.vendaModal(),window.PAINEL_MODULES.pedidosParceiros())',context);
  Object.assign(app,{produtos:[{product_id:id,walkin_sellable:true,price_amount:120,official_unit_cost:40,total_stock_available:4}],
    adminUser:{role:'owner'},modalConv:null,orderSubmitting:false,saleModalOpen:true,orderError:null,
    saleCustomer:{mode:'anonymous',selected:null},salePrepareCustomer:()=>true,saleAddress:{structured:false},
    saleForm:{product_id:id,quantity:2,unit_price:150.5,fulfillment_mode:'pickup',delivery_address:'',payment_method:'Pix',idempotency_key:'walkin-negotiated',source_tag:'walkin_balcao'},
    apiPost:vi.fn().mockResolvedValue({order_id:id}),loadRealData:vi.fn(),loadFinanceiro:vi.fn(),loadVarejoResumo:vi.fn()});
  return app;
}
describe('preço negociado na nova venda de varejo',()=>{
  it.each([150.5,90.25])('preserva o preço vendido %s e a referência em campos distintos na API',price=>{
    expect(registerWalkinOrderSchema.parse(request(price)).items[0]).toMatchObject({unit_price:price,reference_unit_price:120});
  });
  it.each([-1,120.001,Infinity,NaN])('não aceita referência inválida %s',reference=>{
    expect(registerWalkinOrderSchema.safeParse(request(150.5,reference)).success).toBe(false);
  });
  it('não amplia o contrato do registro vinculado ao atendimento',()=>{
    const result=registerManualOrderSchema.parse({...request(),conversation_id:id,source_tag:'chatwoot_com_bot'});
    expect(result.items[0]).not.toHaveProperty('reference_unit_price');
  });
  it('envia o preço alterado, atualiza o total e mantém o catálogo intacto',async()=>{
    const app=ui();expect(app.saleStockError()).toBe(null);
    await app.submitManualOrder();
    expect(app.apiPost).toHaveBeenCalledWith('/admin/api/orders/register-walkin',expect.objectContaining({
      items:[{product_id:id,quantity:2,unit_price:150.5,reference_unit_price:120}],
    }));
    expect(app.saleTotal()).toContain('301,00');
    expect(app.produtos[0].price_amount).toBe(120);
  });
  it.each(['',-1,150.123,Infinity])('não envia valor vendido vazio ou inválido %s',price=>{
    const app=ui();app.saleForm.unit_price=price;
    expect(app.saleCanSubmit()).toBe(false);
  });
  it('ao trocar de produto volta a sugerir o valor daquele produto',()=>{
    const app=ui();app.onProductChanged();expect(app.saleForm.unit_price).toBe(120);
    app.saleForm.unit_price=155;app.saleForm.quantity=3;
    expect(app.saleTotal()).toContain('465,00');
  });
});
