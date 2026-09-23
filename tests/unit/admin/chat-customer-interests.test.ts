import {beforeEach,describe,expect,it,vi} from 'vitest';
const load=vi.hoisted(()=>vi.fn());
vi.mock('../../../src/persistence/db.js',()=>({pool:{}}));
vi.mock('../../../src/admin/painel/customer-lead-interests.js',()=>({loadCustomerLeadInterests:load}));
import {getOperationCustomerInterests} from '../../../src/admin/caixa/chat-customer-interests.js';
beforeEach(()=>vi.clearAllMocks());
describe('categoria dos pneus na ficha',()=>{
  it('usa a classificação do catálogo, preserva interesses e não deduz categoria pela medida',async()=>{
    const interests=['130/70-13','175/65-14','90/90-12'].map(measure=>({measure,variants:[{condition:'novo'}]}));
    load.mockResolvedValue(new Map([['conversation',interests]]));
    const db:any={query:vi.fn().mockResolvedValue({rows:[{measure:'130/70-13',vehicle_type:'motorcycle'},
      {measure:'175/65-14',vehicle_type:'car'},{measure:'90/90-12',vehicle_type:null}]})};
    const result=await getOperationCustomerInterests('test','conversation',db);
    expect(result.map(i=>i.vehicle_type)).toEqual(['motorcycle','car',null]);
    expect(result[0].variants).toEqual(interests[0].variants);
    expect(load).toHaveBeenCalledWith('test',['conversation'],db);
    expect(db.query.mock.calls[0][1]).toEqual(['test',interests.map(i=>i.measure)]);
    expect(db.query.mock.calls[0][0]).toContain('commerce.catalog_vehicle_type');
    expect(interests[0]).not.toHaveProperty('vehicle_type');
  });
  it('não consulta o catálogo sem interesses',async()=>{
    load.mockResolvedValue(new Map());const db:any={query:vi.fn()};
    expect(await getOperationCustomerInterests('prod','conversation',db)).toEqual([]);expect(db.query).not.toHaveBeenCalled();
  });
});
