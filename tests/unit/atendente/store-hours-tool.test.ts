import type { PoolClient } from 'pg';
import { describe,expect,it,vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test',
  DATABASE_URL:'postgresql://test:test@localhost:5432/test',PARTNER_DATABASE_URL:'postgresql://test:test@localhost:5432/test',DATABASE_SSL:false}}));
import { executeTool,activeToolDefinitions } from '../../../src/atendente-v2/tools.js';
const delivery={delivery_enabled:true,pickup_enabled:true,radius_km:12,address:'Matriz teste',latitude:0,longitude:0,
  days:[1,2,3,4,5],opens_at:'09:00',closes_at:'16:00',delivery_days:1};
const saved={...delivery,store_hours:[{day:6,opens_at:'08:00',closes_at:'13:00'}]};
describe('horário consultado pelo bot',()=>{
  it('exibe ferramenta dedicada para identificar a loja e calcular o status',()=>{
    expect(activeToolDefinitions().some(tool=>tool.function.name==='consultar_horario_loja')).toBe(true);
  });
  it('Matriz explícita retorna horário salvo, sem usar entrega como atendimento',async()=>{
    const query=vi.fn(async(sql:string,values:unknown[])=>{
      if(sql.includes('FROM core.messages'))return {rows:[{content:'Horário da Matriz'}]};
      expect(sql).toContain('commerce.matriz_delivery_settings');expect(values).toEqual(['test']);
      return {rows:[{settings:saved,version:7,updated_at:'2026-09-15'}]};
    });
    const result=JSON.parse(await executeTool({query} as unknown as PoolClient,'test','conv','consultar_horario_loja',{loja:'matriz'}));
    expect(result.nome_loja).toBe('Matriz'); expect(result.horario).toContain('sábado: 08:00 às 13:00');
    expect(result.horario).not.toContain('16:00'); expect(result.horario_semanal).toEqual(saved.store_hours);
  });
  it.each(['horario','horario_funcionamento'])('consulta antiga %s também não assume Matriz sem localização',async key=>{
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('commerce.matriz_delivery_settings')
      ?[{settings:saved,version:7,updated_at:'2026-09-15'}]:[]}));
    const result=JSON.parse(await executeTool({query} as unknown as PoolClient,'test','conv','buscar_politica',{policy_keys:[key]}));
    expect(result.politicas.every((policy:any)=>policy.policy_key!=='horario_funcionamento')).toBe(true);
    expect(result.horario_loja).toMatchObject({precisa_localizacao:true,encontrado:false});
    expect(JSON.stringify(result.horario_loja)).not.toContain('sábado: 08:00 às 13:00');
  });
  it('cadastro vazio é informado como ausente sem inventar horário',async()=>{
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('FROM core.messages')?[{content:'Horário da Matriz'}]
      :[{settings:{...delivery,store_hours:null},version:8,updated_at:'2026-09-15'}]}));
    const result=JSON.parse(await executeTool({query} as unknown as PoolClient,'test','conv','consultar_horario_loja',{loja:'matriz'}));
    expect(result.horario_semanal).toBeNull(); expect(result.status_agora.state).toBe('unknown');
  });
});
