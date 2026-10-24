import { expect,it,vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test'}}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{}}));
const management=vi.hoisted(()=>vi.fn());
vi.mock('../../../src/admin/painel/queries-colaboradores-gestao.js',()=>({getMatrizCollaboratorManagement:management}));
import { dotTools } from '../../../src/admin/dot/mcp-server.js';
import { dotSchemas } from '../../../src/admin/dot/consultations.js';
import { readDotTeam } from '../../../src/admin/dot/team-read.js';
import { readContext,pageInput } from '../../../src/admin/dot/read-model.js';
import { dotChatwootAccount } from '../../../src/admin/dot/chat-scope.js';

it('descoberta enumera todas as ferramentas, sem escrita, e coincide com os validadores',()=>{
  expect(dotTools).toHaveLength(30);
  expect(dotTools.map(tool=>tool.name).sort()).toEqual(Object.keys(dotSchemas).sort());
  for(const tool of dotTools) {
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false,openWorldHint:false});
    const properties=tool.inputSchema.properties!;
    for(const extra of [{environment:'prod'},{sql:'select *'},{url:'https://evil.test'},{pagina:0},{pagina:1.5},{pagina:1000001}]) {
      expect(dotSchemas[tool.name as keyof typeof dotSchemas].safeParse({...(tool.name==='consultar_relatorios_matriz'?{area:'varejo'}:{}),...extra}).success).toBe(false);
    }
    if('pagina' in properties)expect(properties.pagina).toMatchObject({minimum:1});
  }
});
it('três pessoas cadastradas não liberam salário ou total pago de uma única pessoa',async()=>{
  const collaborators=Array.from({length:3},(_,i)=>({id:String(i),eligible_in_competence:true,
    employment_type:i===0?'clt':null,commission_active:false,base_salary:i===0?4321:0,total_due:i===0?4321:0,
    payroll_item_id:i===0?'item':null,payroll_status:i===0?'paid':'preview',display_name:'PII-SENTINEL'}));
  management.mockResolvedValue({collaborators,summary:{base_salary_total:4321,payroll_paid:4321,payroll_total:4321}});
  const result=await readDotTeam(readContext({} as never,pageInput.parse({})));
  expect(result.financial).toBeNull();
  expect(JSON.stringify(result)).not.toMatch(/4321|PII-SENTINEL/);
  collaborators.forEach(row=>{row.employment_type='clt';row.payroll_item_id='frozen';row.base_salary=2000;row.total_due=2000;});
  management.mockResolvedValue({collaborators,summary:{base_salary_total:6000,payroll_paid:4321,payroll_total:6000}});
  const three=await readDotTeam(readContext({} as never,pageInput.parse({})));
  expect(three.financial).toMatchObject({base_salary_total:6000,payroll_total:6000,payroll_paid:null});
  expect(JSON.stringify(three)).not.toContain('4321');
  collaborators.forEach((row,i)=>{row.payroll_status='paid';row.total_due=i===0?4321:0;row.base_salary=i===0?4321:0;});
  management.mockResolvedValue({collaborators,summary:{base_salary_total:4321,payroll_paid:4321,payroll_total:4321}});
  const zeroItems=await readDotTeam(readContext({} as never,pageInput.parse({})));
  expect(zeroItems.financial).toMatchObject({base_salary_total:null,payroll_total:null,payroll_paid:null});
  expect(JSON.stringify(zeroItems)).not.toContain('4321');
});
it('sem configuração, a conta é inferida só quando não há ambiguidade',async()=>{
  const query=vi.fn();
  const db={query} as never;
  query.mockResolvedValue({rows:[{chatwoot_account_id:'1'}]});
  expect(await dotChatwootAccount(db)).toBe(1);
  query.mockResolvedValue({rows:[{chatwoot_account_id:'1'},{chatwoot_account_id:'2'}]});
  expect(await dotChatwootAccount(db)).toBeNull();
  query.mockResolvedValue({rows:[]});expect(await dotChatwootAccount(db)).toBeNull();
});
