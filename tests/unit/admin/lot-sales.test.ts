import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {lotSaleSchema,prorateLotCents} from '../../../src/admin/painel/lot-sale-schema.js';
import {requiredMatrixModules} from '../../../src/admin/panel-modules.js';
const valid=()=>({new_customer:{name:'Borracharia QA'},description:'Pneus para borracharia',sold_on:'2026-09-15',amount:1000,discount:0,
 expected_cost:540,payment_status:'pending',due_date:'2026-09-21',idempotency_key:randomUUID(),allocations:[{lot_id:randomUUID(),quantity:100}]});
function app(){
 const window:any={PAINEL_MODULES:{}},storage=new Map<string,string>();
 const sessionStorage={getItem:(key:string)=>storage.get(key),setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)};
 vm.runInNewContext(fs.readFileSync('painel/public/app.vendas.lotes.js','utf8'),{window,sessionStorage,Intl,crypto:{randomUUID}});
 const state:any={isMatrixPanel:()=>true,vendasTab:'lotes',adminUser:{id:'qa',role:'owner'},serverEnvironment:'test',$nextTick:vi.fn(),apiGet:vi.fn(),apiPost:vi.fn(),atacadoBuyerKey:(b:any)=>'c:'+b.customer_id};
 Object.defineProperties(state,Object.getOwnPropertyDescriptors(window.PAINEL_MODULES.vendasLotes()));
 state.lotSales.finance=true;state.lotSales.buyers=[{customer_id:'buyer',name:'Borracharia'}];
 state.lotSales.lots=[{id:'a',quantity_on_hand:60,quantity_reserved:0,available_quantity:60,remaining_cost:300},
 {id:'b',quantity_on_hand:80,quantity_reserved:10,available_quantity:70,remaining_cost:480}];
 Object.assign(state.lotSales.form,{buyer_key:'c:buyer',quantity:'100',amount:'1.000,00'});
 return state;
}
describe('venda de lotes',()=>{
 it('exige vendas e rejeita catálogo, duplicação de lotes, dados financeiros e comprador ambíguos',()=>{
   expect(requiredMatrixModules('/admin/api/wholesale/lot-sales')).toEqual(['vendas']);
   expect(requiredMatrixModules('/admin/api/wholesale/lot-sales/id/cancel')).toEqual(['vendas']);
   expect(lotSaleSchema.safeParse(valid()).success).toBe(true);
   const body=valid();for(const patch of [{items:[]},{customer_id:randomUUID()},{amount:1000.001},{discount:1000},{due_date:'2026-09-14'},
    {payment_status:'paid'},{allocations:[body.allocations[0],body.allocations[0]]},{allocations:[{lot_id:randomUUID(),quantity:1.5}]}]){
     expect(lotSaleSchema.safeParse({...body,...patch}).success).toBe(false);
   }
 });
 it('conserva centavos e o restante em vendas parciais sucessivas',()=>{
   for(const total of [1,100,10001,50000])for(const quantity of [3,7,99]){
    let cents=total,left=quantity,spent=0;
    while(left){const cost=prorateLotCents(cents,1,left);spent+=cost;cents-=cost;left--;}
    expect(spent).toBe(total);expect(cents).toBe(0);
   }
   expect(()=>prorateLotCents(100,4,3)).toThrow();expect(()=>prorateLotCents(-1,1,3)).toThrow();
 });
 it('respeita reservas na distribuição e calcula o custo só do que sai',()=>{
   const s=app();expect(s.lsSelectedQuantity).toBe(100);expect(s.lsCost).toBe(540);expect(s.lsRemaining).toBe(40);expect(s.lsProblem).toBe('');
   s.lotSales.form.quantity=131;expect(s.lsProblem).toContain('Distribua');s.lotSales.form.quantity=100;s.lsManual();
   s.lotSales.form.allocations={a:20,b:80};expect(s.lsProblem).toContain('Distribua');
   s.lotSales.lots=[{id:'a',quantity_on_hand:3,available_quantity:3,remaining_cost:1}];s.lotSales.form.allocations={a:2};s.lotSales.form.quantity=2;expect(s.lsCost).toBe(0.67);
 });
 it('valida dinheiro brasileiro e não converte um desconto inválido silenciosamente em zero',()=>{
   const s=app();for(const amount of ['1.000','1.000,00','1000.00'])expect(s.lsAmount(amount)).toBe(1000);
   for(const discount of ['abc','1,2,3','1e2','-10','10,999']){s.lotSales.form.discount=discount;expect(s.lsProblem).toContain('valor negociado');}
 });
 it('mantém a mesma confirmação após timeout e permite corrigir rejeição definitiva',async()=>{
   const s=app();s.apiPost.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({order_id:'order'});s.loadLotSalesPage=vi.fn();
   await s.lsSubmit();const original={...s.lotSales.pending};s.lotSales.form.quantity=110;await s.lsSubmit();
   expect(s.apiPost.mock.calls[1][1]).toEqual(original);expect(s.lotSales.pending).toBeNull();expect(s.lotSales.message).toContain('confirmada');
   const rejected=app();rejected.apiPost.mockRejectedValue(Object.assign(new Error('lot_sale_cost_changed'),{status:409}));await rejected.lsSubmit();expect(rejected.lotSales.pending).toBeNull();expect(rejected.lotSales.message).toContain('O custo mudou');
 });
 it('salva rascunho sem enviar e mantém o cancelamento vinculado à venda original após falha',async()=>{
   const s=app();s.lsDraft();expect(s.apiPost).not.toHaveBeenCalled();s.lotSales.selected={id:'original'};s.lotSales.cancelReason='Cliente desistiu';
   s.apiPost.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({});s.loadLotSalesPage=vi.fn();await s.lsCancel();s.lotSales.selected={id:'outra'};await s.lsCancel();
   expect(s.apiPost.mock.calls[1][0]).toBe('/admin/api/wholesale/lot-sales/original/cancel');expect(s.apiPost.mock.calls[1][1]).toEqual(s.apiPost.mock.calls[0][1]);
 });
 it('retira detalhes e totais anteriores quando a atualização falha',async()=>{
   const s=app();s.lotSales.rows=[{id:'old'}];s.lotSales.selected={id:'old'};s.lotSales.total=1;
   s.apiGet.mockRejectedValue(new Error('offline'));await s.loadLotSalesPage();expect(s.lotSales.selected).toBeNull();expect(s.lotSales.total).toBe(0);expect(s.lotSales.error).toContain('Não foi possível');
 });
});
