import type { PoolClient } from 'pg';
import { describe,expect,it,vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test',
  DATABASE_URL:'postgresql://test:test@localhost:5432/test',PARTNER_DATABASE_URL:'postgresql://test:test@localhost:5432/test',DATABASE_SSL:false}}));
import { executeTool } from '../../../src/atendente-v2/tools.js';
const delivery={delivery_enabled:true,pickup_enabled:true,radius_km:12,address:'Matriz teste',latitude:0,longitude:0,
  days:[1,2,3,4,5],opens_at:'09:00',closes_at:'16:00',delivery_days:1};

describe('horário consultado pelo bot',()=>{
  it.each(['horario','horario_funcionamento'])('retorna cadastro salvo com a chave %s sem usar entrega como atendimento',async key=>{
    const query=vi.fn(async(sql:string,values:unknown[])=>{
      if(sql.includes('commerce.store_policies')){
        expect(values).toEqual(['test',['horario_funcionamento']]);
        return {rows:[{policy_key:'horario_funcionamento',policy_value:'antigo',policy_version:'v1',description:null}]};
      }
      if(sql.includes('commerce.matriz_delivery_settings')){
        expect(values).toEqual(['test']);
        return {rows:[{settings:{...delivery,store_hours:[{day:6,opens_at:'08:00',closes_at:'13:00'}]},version:7,updated_at:'2026-09-15'}]};
      }
      throw Error('Consulta inesperada: '+sql);
    });
    const result=JSON.parse(await executeTool({query} as unknown as PoolClient,'test','conv','buscar_politica',{policy_keys:[key]}));
    const hours=result.politicas.filter((p:any)=>p.policy_key==='horario_funcionamento');
    expect(hours).toHaveLength(1);
    expect(hours[0].policy_value).toContain('sábado: 08:00 às 13:00');
    expect(hours[0].policy_value).not.toContain('16:00');
    expect(hours[0].policy_version).toBe('matriz-delivery-7');
    expect(query.mock.calls.every(([sql])=>sql.trim().startsWith('SELECT'))).toBe(true);
  });
  it('cadastro vazio é informado como ausente sem inventar horário',async()=>{
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('commerce.matriz_delivery_settings')
      ?[{settings:{...delivery,store_hours:null},version:8,updated_at:'2026-09-15'}]:[]}));
    const result=JSON.parse(await executeTool({query} as unknown as PoolClient,'test','conv','buscar_politica',{policy_keys:['horario']}));
    expect(result.politicas.find((p:any)=>p.policy_key==='horario_funcionamento').policy_value).toContain('não cadastrado');
  });
});
