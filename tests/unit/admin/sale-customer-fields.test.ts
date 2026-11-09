import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { saleAddressSchema, formatSaleAddress } from '../../../src/admin/painel/sale-address.js';
import { registerWalkinOrderSchema } from '../../../src/admin/painel/route-schemas-orders.js';
function ui(): any {
  const sandbox={window:{PAINEL_MODULES:{} as any},crypto};
  vm.runInNewContext(readFileSync('painel/public/app.venda.modal.js','utf8'),sandbox);
  return Object.assign(sandbox.window.PAINEL_MODULES.vendaModal(),{saleForm:{},modalConv:null});
}
describe('campos e seleção de cliente',()=>{
  it('formata fixo, celular e telefone colado com +55 sem alterar internacional',()=>{
    const c=ui();expect(c.salePhoneFormat('21999998888')).toBe('(21) 99999-8888');
    expect(c.salePhoneFormat('+55 (21) 99999-8888')).toBe('(21) 99999-8888');
    expect(c.salePhoneFormat('2122223333')).toBe('(21) 2222-3333');
    expect(c.salePhoneFormat('+14155552671')).toBe('+14155552671');
    expect(c.salePhoneValid('(21) 9999-8888')).toBe(false);
    expect(c.salePhoneValid('(21) 99999-8888')).toBe(true);
    expect(c.saleCepFormat('24000123')).toBe('24000-123');
    expect(c.saleCleanText('  João   de Sá  ')).toBe('João de Sá');
  });
  it('não deixa resposta antiga substituir busca ou cliente selecionado',async()=>{
    const c=ui();let finish:any;
    c.apiGet=vi.fn().mockReturnValueOnce(new Promise(r=>{finish=r;})).mockResolvedValueOnce({rows:[{id:'new'}]});
    c.saleCustomer.query='Maria';const first=c.saleCustomerSearch();
    c.saleCustomer.query='José';await c.saleCustomerSearch();finish({rows:[{id:'old'}]});await first;
    expect(c.saleCustomer.rows[0].id).toBe('new');
    c.saleCustomer.query='Maria';c.apiGet=vi.fn().mockResolvedValue({summary:{purchases:2}});
    await c.saleCustomerSelect({source:'balcao',id:'id',name:'Maria',phone:'+5521999998888'});
    expect(c.saleCustomer.selected.id).toBe('id');expect(c.saleForm.customer_phone).toBe('(21) 99999-8888');
    c.saleCustomerReset('anonymous');expect(c.saleCustomer.selected).toBeNull();expect(c.saleForm.customer_phone).toBe('');
  });
  it('exige seleção explícita e mantém modo novo ao validar campos',()=>{
    const c=ui();expect(c.salePrepareCustomer()).toBe(false);
    c.saleCustomerReset('new');c.saleForm.customer_name=' João ';c.saleForm.customer_phone='123';
    expect(c.salePrepareCustomer()).toBe(false);expect(c.saleCustomer.error).toContain('DDD');
    c.saleForm.customer_phone='21999998888';expect(c.salePrepareCustomer()).toBe(true);
    expect(c.saleForm.customer_name).toBe('João');
  });
  it('valida número, UF e CEP no servidor e monta endereço sem número',()=>{
    const a={street:' Rua  Um ',number:'',no_number:true,complement:'',district:'Centro',city:'Niterói',uf:'RJ' as const,cep:'24000-123'};
    expect(formatSaleAddress(a)).toBe('Rua Um, s/n, Centro, Niterói - RJ, 24000-123');
    expect(saleAddressSchema.safeParse({...a,no_number:false}).success).toBe(false);
    expect(saleAddressSchema.safeParse({...a,uf:'XX'}).success).toBe(false);
    expect(saleAddressSchema.safeParse({...a,cep:'123'}).success).toBe(false);
    expect(registerWalkinOrderSchema.safeParse({customer_ref:{source:'parceiro',id:crypto.randomUUID()}}).success).toBe(false);
  });
  it('preenche último endereço apenas quando solicitado',async()=>{
    const c=ui();c.apiGet=vi.fn().mockResolvedValue({customer:{address:'Rua anterior, 10'}});
    c.saleForm.delivery_address='';await c.saleCustomerSelect({source:'balcao',id:'id'});
    expect(c.saleForm.delivery_address).toBe('');c.saleUseLastAddress();
    expect(c.saleForm.delivery_address).toBe('Rua anterior, 10');expect(c.saleAddress.structured).toBe(false);
  });
  it('reabre venda sem reaproveitar cliente ou endereço anteriores',async()=>{
    const c=ui();c.apiGet=vi.fn().mockResolvedValue({rows:[]});c.applyProdutos=vi.fn();c.produtos=[];
    c.saleCustomer.selected={id:'antigo'};c.saleAddress.fields.street='Rua antiga';
    await c.openWalkinModal();
    expect(c.saleCustomer.selected).toBeNull();expect(c.saleAddress.fields.street).toBe('');expect(c.saleAddress.structured).toBe(true);
  });
  it('preserva posição do cursor ao editar telefone no meio',()=>{
    const c=ui(),setSelectionRange=vi.fn();
    c.saleMaskInput({target:{value:'(21) 98888-7777',selectionStart:7,setSelectionRange}},'phone');
    expect(c.saleForm.customer_phone).toBe('(21) 98888-7777');expect(setSelectionRange).toHaveBeenCalledWith(7,7);
  });
});
