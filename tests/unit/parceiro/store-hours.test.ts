import type { Pool } from 'pg';
import type { PartnerContext } from '../../../src/parceiro/auth.js';
import { describe,expect,it,vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',DATABASE_SSL:false}}));
import { getPartnerStoreHours,savePartnerStoreHours } from '../../../src/parceiro/store-hours.js';
const ctx={environment:'test',partnerUnitId:'unit-a',slug:'loja-a',tokenId:'operator-a'} as PartnerContext;
describe('persistência e compatibilidade do horário do parceiro',()=>{
  it('conserva texto antigo sem inventar horários estruturados',async()=>{
    const query=vi.fn().mockResolvedValue({rows:[{hours:null,legacy_text:'Segunda a sábado, 8h às 18h',schema_ready:true}]});
    const db={connect:vi.fn().mockResolvedValue({query,release:vi.fn()})};
    const result=await getPartnerStoreHours(ctx,db as unknown as Pool);
    expect(result).toMatchObject({hours:null,legacy_text:'Segunda a sábado, 8h às 18h',status:{state:'unknown'}});
    expect(query.mock.calls.find(([sql])=>sql.includes('FROM network.partner_units'))?.[1]).toEqual(['unit-a','test']);
    expect(query.mock.calls[1][1]).toEqual(['unit-a']);
  });
  it('atualiza somente horários e audita na mesma transação, sem alterar endereço',async()=>{
    const query=vi.fn(async(sql:string)=>sql.includes('FOR UPDATE')?{rowCount:1,rows:[{opening_hours_text:'antigo',opening_hours_weekly:null}]}:{rows:[],rowCount:1});
    const release=vi.fn(); const db={connect:vi.fn().mockResolvedValue({query,release})};
    const result=await savePartnerStoreHours(ctx,[{day:1,opens_at:'08:00',closes_at:'18:00'}],db as unknown as Pool);
    expect(result?.hours).toHaveLength(1);
    const [sql,values]=query.mock.calls.find(([sql])=>sql.startsWith('UPDATE'))!;
    expect(sql).not.toMatch(/address|service_mode|delivery_radius|quantity/); expect(values?.slice(0,2)).toEqual(['unit-a','test']);
    expect(query.mock.calls.some(([sql])=>sql.includes('INSERT INTO audit.events'))).toBe(true);
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT'); expect(release).toHaveBeenCalledOnce();
  });
  it('falha de auditoria reverte a alteração',async()=>{
    const query=vi.fn(async(sql:string)=>{ if(sql.includes('audit.events'))throw Error('audit failed');
      return {rowCount:1,rows:[{opening_hours_text:'antigo'}]}; });
    const release=vi.fn(); const db={connect:vi.fn().mockResolvedValue({query,release})};
    await expect(savePartnerStoreHours(ctx,[],db as unknown as Pool)).rejects.toThrow('audit failed');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK'); expect(release).toHaveBeenCalledOnce();
  });
});
