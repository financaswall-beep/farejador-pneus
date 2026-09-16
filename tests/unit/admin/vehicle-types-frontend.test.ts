import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
function app(files: string[] = []) {
  const sandbox: any = { window: { PAINEL_MODULES: {} }, URLSearchParams, console, setTimeout,
    localStorage: { getItem: vi.fn(), setItem: vi.fn() } };
  for (const file of ['app.vehicle-types.js', 'app.catalogo.js', ...files]) {
    vm.runInNewContext(readFileSync('painel/public/'+file,'utf8'),sandbox);
  }
  const state: any = {catalogoRows:[],catalogoFiltro:'todos',catalogoMarca:'todas',catalogoBusca:'',
    atacadoStock:[],produtos:[],catalogoConditionLabel:()=>'',catalogoPositionLabel:()=>'',onProductChanged:vi.fn()};
  for (const factory of Object.values(sandbox.window.PAINEL_MODULES) as Function[]) {
    Object.defineProperties(state,Object.getOwnPropertyDescriptors(factory()));
  }
  return state;
}
describe('carro e moto no painel',()=>{
  it('filtra categoria sem confundir meia-vida, sem inferir pela medida e sem destruir o catálogo compartilhado',()=>{
    const a=app();a.catalogoRows=[
      {product_type:'tire',tire_size:'130/70-13',vehicle_type:'motorcycle',tire_condition:'meia_vida',catalogued:true},
      {product_type:'tire',tire_size:'195/65R15',vehicle_type:'car',tire_condition:'meia_vida',catalogued:true},
      {product_type:'tire',tire_size:'205/55R16',vehicle_type:null,catalogued:true},
      {product_type:'tire',tire_size:'215/60-16',vehicle_type:'car',measure_draft:true},
    ];
    a.catalogoVehicleType='car';expect(a.catalogoFiltrados()).toHaveLength(2);
    expect(a.catalogoVehicleSummary.products).toBe(1);
    expect(a.catalogoVehicleSummary.incomplete_registrations).toBe(1);
    a.catalogoVehicleType='unknown';expect(a.catalogoFiltrados().map((r:any)=>r.tire_size)).toEqual(['205/55R16']);
    expect(a.catalogoRows).toHaveLength(4);
  });
  it('filtra o estoque e a venda e impede que o produto selecionado continue oculto no novo filtro',()=>{
    const a=app();a.atacadoStock=[{vehicle_type:'car',quantity_on_hand:2},{vehicle_type:'motorcycle',quantity_on_hand:3}];
    a.stockVehicleType='car';expect(a.stockVehicleRows).toHaveLength(1);
    a.produtos=[{product_id:'m',vehicle_type:'motorcycle',walkin_sellable:true},{product_id:'c',vehicle_type:'car',walkin_sellable:true},
      {product_id:'service',product_type:'service',vehicle_type:null,walkin_sellable:true}];
    a.saleForm={product_id:'m'};a.saleVehicleType='car';a.saleVehicleChanged();
    expect(a.saleForm.product_id).toBe('c');expect(a.onProductChanged).toHaveBeenCalledOnce();
    a.saleVehicleType='unknown';a.saleVehicleChanged();expect(a.saleForm.product_id).toBe('');
  });
  it('mantém grupos de reposição separados mesmo se a medida e condição coincidirem',()=>{
    const a=app(['app.compras.reposicao.js']);a.measureAvailable=(r:any)=>r.quantity_on_hand;
    const rows=[{measure:'130/70-13',brand:'A',tire_condition:'novo',vehicle_type:'motorcycle',quantity_on_hand:1,min_quantity:4},
      {measure:'130/70-13',brand:'B',tire_condition:'novo',vehicle_type:'car',quantity_on_hand:20,min_quantity:10}];
    const groups=a.comprasReplenishmentStockGroups(rows);expect(groups).toHaveLength(2);
    expect(groups.find((r:any)=>r.vehicle_type==='motorcycle').quantity_available).toBe(1);
  });
  it('envia o tipo nos relatórios e mantém a seleção por item em compras',()=>{
    const a=app(['app.relatorios.js','app.relatorios.compras.js','app.relatorios.estoque.js','app.relatorios.demanda.js','app.relatorios.faltas.js']);
    for(const prefix of ['rp','rcomp','rst','rdem','rfal']) {
      a[prefix].vehicle_type='car';
      expect(new URLSearchParams(a[prefix+'Query'](a[prefix])).get('vehicle_type')).toBe('car');
    }
    a.catalogoRows=[{product_type:'tire',tire_size:'195/65R15',brand:'X',tire_condition:'novo',vehicle_type:'car'}];
    const item={measure:'195/65-15',brand:'X',tire_condition:'novo',vehicle_type:''};a.purchaseVehicleResolve(item);
    expect(item.vehicle_type).toBe('car');
  });
});
