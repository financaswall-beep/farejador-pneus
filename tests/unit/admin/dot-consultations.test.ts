import { describe, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(()=>({stock:vi.fn(),sales:vi.fn(),attention:vi.fn(),financial:vi.fn(),open:vi.fn(),query:vi.fn()}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test',MATRIZ_LOGISTICS:true,
  DOT_MCP_ENABLED:false,DOT_MCP_CLIENT_ID:'farejador-dot',DOT_MCP_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect'}}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{}}));
vi.mock('../../../src/admin/dot/read-only.js',()=>({withDotReadOnly:(work:Function)=>work({query:mocks.query})}));
vi.mock('../../../src/admin/painel/queries-stock-report.js',()=>({getStockReport:mocks.stock}));
vi.mock('../../../src/admin/painel/matriz-overview-sales.js',()=>({readOverviewSales:mocks.sales}));
vi.mock('../../../src/admin/painel/matriz-overview-operations.js',()=>({readOverviewAttention:mocks.attention}));
vi.mock('../../../src/admin/painel/queries-financeiro-read-switch.js',()=>({getMatrizFinancialRead:mocks.financial,
  MatrizCentralLedgerUnavailableError:class extends Error{}}));
vi.mock('../../../src/admin/painel/matriz-ledger-open-items.js',()=>({getMatrizLedgerOpenItems:mocks.open}));
import { dotPeriod, dotSchemas, runDotConsultation } from '../../../src/admin/dot/consultations.js';
import { dotConfig } from '../../../src/admin/dot/config.js';
import { parseAuthorization } from '../../../src/admin/dot/oauth-validation.js';

describe('consultas do Dot',()=>{
  it('usa a data de São Paulo na virada UTC e não aceita mês futuro',()=>{
    expect(dotPeriod({periodo:'hoje'},new Date('2026-10-01T01:00:00Z'))).toMatchObject({from:'2026-09-30',to:'2026-09-30'});
    expect(dotPeriod({periodo:'30dias'},new Date('2026-10-01T01:00:00Z'))).toMatchObject({from:'2026-09-01',to:'2026-09-30'});
    expect(()=>dotPeriod({periodo:'mes',mes:'2027-01'},new Date('2026-10-23T12:00:00Z'))).toThrow('invalid_month');
    expect(()=>dotPeriod({periodo:'hoje',mes:'2026-09'})).toThrow('month_requires_month_period');
  });
  it('não aceita ambiente, SQL, URL ou argumentos desconhecidos do modelo',()=>{
    for(const schema of Object.values(dotSchemas))for(const extra of [{environment:'prod'},{sql:'DELETE'},{url:'https://evil.example'}]) {
      expect(schema.safeParse(extra).success).toBe(false);
    }
  });
  it('permanece desativado por padrão',()=>expect(dotConfig()).toBeNull());
  it('callback exige correspondência exata e escopo somente leitura',()=>{
    const config={origin:'https://app.example',resource:'https://app.example/admin/dot/mcp',clientId:'farejador-dot',redirects:['https://chatgpt.com/callback']};
    const input={client_id:'farejador-dot',resource:config.resource,redirect_uri:config.redirects[0],scope:'farejador.read',
      response_type:'code',state:'state',code_challenge:'a'.repeat(43),code_challenge_method:'S256'};
    expect(parseAuthorization(config,input)).toBeTruthy();
    expect(parseAuthorization(config,{...input,redirect_uri:'https://chatgpt.com/callback/other'})).toBeNull();
    expect(parseAuthorization(config,{...input,scope:'farejador.write'})).toBeNull();
  });
  it('ignora extensões OAuth do cliente sem preservar dados extras ou afrouxar campos conhecidos',()=>{
    const config={origin:'https://app.example',resource:'https://app.example/admin/dot/mcp',clientId:'farejador-dot',redirects:['https://chatgpt.com/callback']};
    const input={client_id:'farejador-dot',resource:config.resource,redirect_uri:config.redirects[0],scope:'farejador.read',
      response_type:'code',state:'state',code_challenge:'a'.repeat(43),code_challenge_method:'S256'};
    const extensions={ui_locales:'pt-BR',login_hint:'IGNORED-HINT',environment:'prod'};
    expect(parseAuthorization(config,{...input,...extensions})).toEqual(input);
    for(const key of Object.keys(input)) {
      const missing:Record<string,unknown>={...input,...extensions}; delete missing[key];
      expect(parseAuthorization(config,missing),`ausente: ${key}`).toBeNull();
      expect(parseAuthorization(config,{...input,...extensions,[key]:[input[key as keyof typeof input],input[key as keyof typeof input]]}),`repetido: ${key}`).toBeNull();
    }
    for(const invalid of [{client_id:'outro-cliente'},{resource:config.origin},{redirect_uri:'https://evil.example'},
      {scope:'farejador.write'},{code_challenge_method:'plain'},{code_challenge:'a'.repeat(42)},
      {response_type:'token'},{state:''}]) {
      expect(parseAuthorization(config,{...input,...extensions,...invalid})).toBeNull();
    }
  });
  it('limita estoque a 50 e projeta campos, sem repassar PII de queries futuras',async()=>{
    mocks.stock.mockResolvedValue({as_of:'now',summary:{available:60},groups:Array.from({length:60},()=>({measure:'110/90-17',
      physical:1,reserved:0,available:1,incoming:0,customer_name:'PII-SENTINEL',phone:'PII-SENTINEL',extra:'PII-SENTINEL'}))});
    const result=await runDotConsultation('consultar_estoque_matriz',{});
    expect(result).toMatchObject({total:60,truncated:true,environment:'test'});
    expect(result.products).toHaveLength(50);
    expect(JSON.stringify(result)).not.toContain('PII-SENTINEL');
    expect(mocks.stock.mock.calls.at(-1)?.[1]).toBe('test');
  });
  it('entregas expõem número/status/data e preservam o total ao truncar',async()=>{
    mocks.query.mockImplementation(async(sql:string)=>sql.includes('matriz_trip_receipts')?{rows:[{pending:2}]}:
      {rows:Array.from({length:51},()=>({order_number:'PED-0037',delivery_status:'failed',total:75,
        customer_name:'PII-SENTINEL',customer_phone:'PII-SENTINEL',delivery_address:'PII-SENTINEL'}))});
    const result=await runDotConsultation('consultar_entregas_matriz',{situacao:'problemas'});
    expect(result).toMatchObject({total:75,truncated:true,notas_aguardando_conferencia:2});
    expect(result.deliveries).toHaveLength(50);
    expect(JSON.stringify(result)).not.toContain('PII-SENTINEL');
    expect(mocks.query.mock.calls.every(call=>call[1][0]==='test')).toBe(true);
  });
  it('financeiro agrega pendências sem nomes, telefones nem descrições',async()=>{
    mocks.financial.mockResolvedValue({source:'central_ledger',integration_status:'yellow',truth:{
      competencia:{receita_total:'100.00',lucro_confirmado:'10.00',status:'custo_pendente'},caixa:{saldo_atual:'20.00'},
      conciliacao:{status:'custo_pendente',custo_pendente:{itens:2},qualidade:{registros_teste_suspeitos:0}},
      customer_name:'PII-SENTINEL'}});
    mocks.open.mockResolvedValue({a_receber:{itens:[{valor:'10.00',nome:'PII-SENTINEL',phone:'PII-SENTINEL',due_date:null,overdue:false}]},a_pagar:{itens:[]}});
    const result=await runDotConsultation('consultar_financeiro_matriz',{});
    expect(result).toMatchObject({available:true,receivable:{total_brl:'10.00',count:1,without_due_date_count:1}});
    expect(JSON.stringify(result)).not.toContain('PII-SENTINEL');
  });
  it('falha de fonte não é convertida em saldo zero',async()=>{
    mocks.financial.mockRejectedValue(new Error('database unavailable'));
    await expect(runDotConsultation('consultar_financeiro_matriz',{})).rejects.toThrow('database unavailable');
  });
});
