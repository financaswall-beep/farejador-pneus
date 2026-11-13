import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { McpError, ErrorCode, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import { DOT_SCOPE } from './config.js';
import type { DotIdentity } from './token-store.js';
import { lockGrant,transact } from './installment-reviews.js';
import { id,money,instant,agreementInput,renegotiate,serviceInput,createService,recurrenceInput,scheduleExpenses,
  reversalInput,reverseSettlement } from './finance-operations.js';
import { agenda,agendaInput,compareStatement,bankInput,simulate,simulationInput } from './finance-analysis.js';
import { createMatrizExpenseSchema } from '../painel/route-schemas-expenses.js';
import { createMatrizExpenseOnClient,settleMatrizExpenseOnClient } from '../painel/queries-financeiro-despesas-integridade.js';
import { storeReceiptOnClient,lockExpenseReceipt,linkExpenseReceipt } from '../painel/expense-receipts.js';
import { downloadReceiptFile } from './events/https.js';
import { reencodePhoto } from '../../parceiro/photo-upload.js';
import { lotSaleSchema } from '../painel/lot-sale-schema.js';
import { checkExistingLotSale } from './lot-sale-check.js';
import { registerLotSaleOnClient } from '../painel/register-lot-sale.js';
import { registerWholesaleSaleSchema } from '../painel/route-schemas.js';
import { registerWholesaleSaleOnClient } from '../painel/queries-atacado-vendas.js';
import { listSaleLots } from '../painel/queries-lot-sales.js';
import { settleMatrizLedgerOpenItemOnClient } from '../painel/matriz-ledger-settlement.js';
import { lockSettlementObligation } from '../painel/matriz-ledger-settlement-payment.js';
import { purchaseInstallmentBalancesSql } from '../painel/purchase-installment-balances.js';
import { manualEntrySchema, reverseManualEntrySchema } from '../painel/manual-finance-entry-schema.js';
import { createManualEntryOnClient, reverseManualFinanceEntry } from '../painel/manual-finance-entry.js';
import { listPurchaseGroups,getPurchaseGroup } from '../painel/queries-purchase-groups.js';
import { linkPurchaseGroupInTransaction } from '../painel/purchase-group-links.js';
import { beginIntegrityOperation,completeIntegrityOperation,operationFingerprint,recordIntegrityEvent } from '../painel/stage5-integrity.js';

const tools=new Map<string,{descriptor:Tool;call:(identity:DotIdentity,args:unknown)=>Promise<object>}>();
function describe(name:string,description:string,schema:z.ZodTypeAny,write:boolean):Tool & {securitySchemes:{type:string;scopes:string[]}[]} {
  const { $schema,...json }=zodToJsonSchema(schema,{$refStrategy:'none',effectStrategy:'input'});
  const securitySchemes=[{type:'oauth2',scopes:[DOT_SCOPE]}];
  return {name,description,inputSchema:json as Tool['inputSchema'],annotations:{readOnlyHint:!write,destructiveHint:write,
    idempotentHint:true,openWorldHint:name==='anexar_comprovante_despesa'},securitySchemes,_meta:{securitySchemes,
      ...(name==='anexar_comprovante_despesa'?{'openai/fileParams':['arquivo']}:{})}};
}
function parse<S extends z.ZodTypeAny>(schema:S,args:unknown):z.output<S> {
  const parsed=schema.safeParse(args??{});
  if (!parsed.success) throw new McpError(ErrorCode.InvalidParams,'Confira os campos: '+parsed.error.issues.map(i=>i.path.join('.')||i.code).join(', '));
  return parsed.data;
}
function write<S extends z.ZodTypeAny>(name:string,description:string,schema:S,
  execute:(db:PoolClient,data:z.output<S>,actor:string,identity:DotIdentity)=>Promise<object>) {
  tools.set(name,{descriptor:describe(name,description+' Execute após o dono autorizar esta operação por voz ou texto. Reutilize idempotency_key ao repetir.',schema,true),
    call:(identity,args)=>transact(async db=>{
      const grant=await lockGrant(db,identity.person_id,identity.grant_id);
      if (!grant.finance_operations_enabled) throw new McpError(ErrorCode.InvalidRequest,'Conexão em modo de consulta financeira. O dono pode liberar lançamentos em Conexões.');
      if (!env.MATRIZ_CENTRAL_LEDGER || !env.MATRIZ_CENTRAL_LEDGER_READ) throw Error('central_ledger_disabled');
      const data=parse(schema,args);
      const actor='Milly · '+identity.person_id;
      const key=id.parse(data.idempotency_key);
      const operation={environment:env.FAREJADOR_ENV,domain:'dot.'+name,idempotencyKey:key,
        fingerprint:operationFingerprint({grant:identity.grant_id,
          data:data.arquivo?{...data,arquivo:{file_id:data.arquivo.file_id}}:data})};
      const previous=await beginIntegrityOperation<object>(db,operation);
      if(previous.replayed) return previous.result;
      const result=await execute(db,data,actor,identity);
      await recordIntegrityEvent(db,{environment:env.FAREJADOR_ENV,domain:'dot_finance',entityTable:'network.dot_oauth_grants',
        entityId:identity.grant_id,actorLabel:actor,eventType:name,idempotencyKey:key,after:{operation:key}});
      await completeIntegrityOperation(db,operation,'network.dot_oauth_grants',identity.grant_id,result);
      return result;
    })});
}
function read<S extends z.ZodTypeAny>(name:string,description:string,schema:S,execute:(data:z.output<S>)=>Promise<object>) {
  tools.set(name,{descriptor:describe(name,description,schema,false),call:(_identity,args)=>execute(parse(schema,args))});
}
const expense=createMatrizExpenseSchema.innerType().extend({amount:money,payment_status:z.enum(['paid','pending']),
  payment_method:z.string().trim().min(2).max(40).optional(),cash_account:z.string().trim().min(2).max(80).optional(),idempotency_key:id}).strict();
write('lancar_despesa_matriz','Registra uma despesa paga ou a pagar, com categoria ativa e viagem opcional. Pergunte pelo comprovante e aceite “não tenho”.',expense,
  async(db,data,actor)=>{
    if (!env.MATRIZ_EXPENSES) throw Error('expenses_disabled');
    createMatrizExpenseSchema.parse(data);
    if(data.payment_status==='pending' && (data.paid_at || data.cash_account || data.payment_method)) throw Error('despesa_pendente_sem_pagamento');
    if (data.payment_status==='paid' && data.due_date) throw Error('despesa_paga_nao_aceita_vencimento');
    return createMatrizExpenseOnClient(db,{...data,created_by:actor});
  });
const attachment=z.object({expense_id:id,valor_esperado:money,data_esperada:z.string().date().optional(),receipt_id:id.optional(),
  arquivo:z.object({download_url:z.string().url().max(8192),file_id:z.string().min(1).max(200),mime_type:z.string().max(100).optional(),
    file_name:z.string().max(300).optional()}).strict().optional(),
  imagem_base64:z.string().min(16).max(1400000).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional(),idempotency_key:id}).strict()
  .refine(d=>[d.receipt_id,d.imagem_base64,d.arquivo].filter(Boolean).length===1);
write('anexar_comprovante_despesa','Anexa foto JPEG, PNG ou WebP (até 1 MB) ou comprovante existente pelo UUID. Confira o valor e informe data_esperada, o dia de occurred_at em São Paulo. A foto não dá baixa.',attachment,
  async(db,data,actor)=>{
    if (!env.MATRIZ_EXPENSES) throw Error('expenses_disabled');
    const environment=env.FAREJADOR_ENV;
    const current=(await db.query(`SELECT amount,(occurred_at AT TIME ZONE 'America/Sao_Paulo')::date::text dia
      FROM commerce.matriz_expenses WHERE environment=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [environment,data.expense_id])).rows[0];
    if(!current || Number(current.amount)!==data.valor_esperado || (data.data_esperada && current.dia!==data.data_esperada))
      throw Error('despesa_diverge_da_autorizacao');
    let receipt=data.receipt_id;
    if(!receipt) {
      const bytes=data.arquivo?await downloadReceiptFile(data.arquivo.download_url):Buffer.from(data.imagem_base64!,'base64');
      if(bytes.length>1048576) throw Error('imagem_acima_de_1mb');
      const photo=await reencodePhoto(bytes);
      receipt=(await storeReceiptOnClient(db,photo.bytes,actor)).id;
    }
    const existing=(await db.query('SELECT id FROM commerce.matriz_expense_receipts WHERE environment=$1 AND expense_id=$2',[environment,data.expense_id])).rows[0];
    if (existing && existing.id!==receipt) throw Error('despesa_ja_tem_comprovante');
    if (!existing) {
      await lockExpenseReceipt(db,environment,receipt!);
      await linkExpenseReceipt(db,environment,receipt!,data.expense_id);
    }
    return {expense_id:data.expense_id,receipt_id:receipt};
  });
const page=z.number().int().min(1).max(10000).default(1);
read('consultar_lotes_para_venda','Lotes disponíveis com UUID, quantidade em mãos, reservas e custo remanescente para calcular a alocação.',z.object({pagina:page}).strict(),
  async({pagina})=>{const rows=await listSaleLots();return {lotes:rows.slice((pagina-1)*50,pagina*50),proxima_pagina:rows.length>pagina*50?pagina+1:null};});
const voiceLotSale=lotSaleSchema.innerType().extend({
  vendas_distintas_de:z.array(id).max(100).optional(),
}).strict();
write('registrar_venda_lote','Venda única de lote com comprador, quantidades, valor, entrada e parcelas. Localize a venda antes de criar. vendas_distintas_de só se o dono identificar outra venda real com os mesmos dados.',voiceLotSale,
  async(db,{vendas_distintas_de,...fields},actor,identity)=>{
    const sale=lotSaleSchema.parse(fields);
    await checkExistingLotSale(db,sale,vendas_distintas_de??[]);
    return registerLotSaleOnClient(db,sale,actor,identity.collaborator_id);
  });
write('registrar_venda_atacado','Venda do estoque de atacado com itens, comprador, entrada e parcelas. Respeita o fluxo de venda ao parceiro.',registerWholesaleSaleSchema,
  (db,data,actor,identity)=>{
    if(!env.WHOLESALE_FINANCE || !data.payment_status) throw Error('informe_situacao_da_venda_e_habilite_atacado');
    return registerWholesaleSaleOnClient(db,{...data,created_by:actor,seller_collaborator_id:identity.collaborator_id});
  });
read('consultar_titulos_financeiros','Lista títulos por nome, tipo ou UUID, com saldo e identificadores de baixa. UUID da obrigação é diferente do UUID da venda.',agendaInput,agenda);
const settlement=z.object({obligation_id:id,lado:z.enum(['a_pagar','a_receber']),amount:money,
  sale_installment:z.object({order_id:id,number:z.number().int().min(1).max(120)}).strict().optional(),
  parcela_compra:z.number().int().positive().optional(),paid_at:instant,payment_method:z.string().trim().min(2).max(40),
  cash_account:z.string().trim().min(2).max(80),note:z.string().trim().max(500).optional(),idempotency_key:id}).strict();
async function settleTitle(db:PoolClient,data:z.infer<typeof settlement>,actor:string) {
  const expense=(await db.query(`SELECT t.source_id expense_id,e.amount FROM finance.matriz_ledger_transactions t
    JOIN commerce.matriz_expenses e ON e.environment=t.environment AND e.id::text=t.source_id
    WHERE t.environment=$1 AND t.id=$2 AND t.source_type='commerce.matriz_expense.accrual'
      AND e.payment_status='pending' AND e.deleted_at IS NULL FOR UPDATE OF e`,[env.FAREJADOR_ENV,data.obligation_id])).rows[0];
  if (expense) {
    if (!env.MATRIZ_EXPENSES || data.lado!=='a_pagar' || data.amount!==Number(expense.amount) || data.sale_installment || data.parcela_compra)
      throw Error('despesa_exige_baixa_integral');
    await settleMatrizExpenseOnClient(db,expense.expense_id,env.FAREJADOR_ENV,{...data,actor_label:actor});
    return {target_id:data.obligation_id,amount:data.amount,remaining_balance:'0.00'};
  }
  const target=await lockSettlementObligation(db,env.FAREJADOR_ENV,data.obligation_id);
  if ((target.account_class==='asset') !== (data.lado==='a_receber')) throw Error('direcao_incompativel');
  if(target.sale_plan && !data.sale_installment) throw Error('informe_a_parcela_da_venda');
  let balance:number|undefined;
  if(target.source_type==='commerce.wholesale_purchase.accrual') {
    const part=(await db.query(`SELECT i.installment_number,i.balance FROM commerce.wholesale_purchases p
      CROSS JOIN LATERAL (${purchaseInstallmentBalancesSql}) i
      WHERE p.environment=$1 AND p.id=$2 AND i.balance>0 AND ($3::int IS NULL OR i.installment_number=$3)
      ORDER BY i.installment_number LIMIT 1`,[env.FAREJADOR_ENV,target.source_id,data.parcela_compra??null])).rows[0];
    if(!part && data.parcela_compra) throw Error('parcela_compra_invalida');
    if(part && !data.parcela_compra) throw Error('informe_a_parcela_da_compra');
    if(part && data.amount>Number(part.balance)) throw Error('settlement_exceeds_balance');
    if(part) balance=Number(part.balance);
  } else if(data.parcela_compra) throw Error('parcela_compra_invalida');
  const result=await settleMatrizLedgerOpenItemOnClient(db,{...data,purchase_installment:data.parcela_compra,actor_label:actor});
  return balance===undefined?result:{...result,installment_remaining_balance:(balance-data.amount).toFixed(2)};
}
write('registrar_baixa_financeira','Recebimento ou pagamento já realizado, inclusive parcial e devoluções existentes. Informe a parcela indicada pelo dono em vendas e compras parceladas.',settlement,
  (db,data,actor)=>settleTitle(db,data,actor));
const correction=reversalInput.extend({destino:settlement.omit({idempotency_key:true,amount:true}).optional()});
write('estornar_baixa_financeira','Corrige uma baixa central específica pelo ID da transação e valor original. Se o dono indicar a parcela certa, informe destino para estornar e reaplicar na mesma transação.',correction,
  async(db,data,actor)=>{
    const result=await reverseSettlement(db,data,actor);
    if(!data.destino) return result;
    const receipt=await settleTitle(db,{...data.destino,amount:data.valor_esperado,idempotency_key:data.idempotency_key},actor);
    return {...result,baixa_corrigida:receipt};
  });
write('renegociar_parcelas_venda','Troca o calendário e a divisão do saldo restante de uma venda parcelada, preservando o que já foi recebido.',agreementInput,renegotiate);
write('criar_cobranca_servico','Registra um serviço prestado a receber de um cliente com valor e vencimento.',serviceInput,createService);
write('agendar_despesas_mensais','Cria de 1 a 36 contas mensais a pagar, com competência no mês do vencimento. Em meses mais curtos usa o último dia.',recurrenceInput,scheduleExpenses);
write('registrar_entrada_avulsa','Registra receita avulsa recebida ou aporte do proprietário em uma conta.',manualEntrySchema,(db,data,actor)=>createManualEntryOnClient(db,data,actor));
const manualReverse=reverseManualEntrySchema.extend({entrada_id:id});
write('estornar_entrada_avulsa','Estorna um aporte ou receita avulsa pelo UUID e motivo.',manualReverse,
  (db,{entrada_id,...data},actor)=>reverseManualFinanceEntry(entrada_id,data,actor,env.FAREJADOR_ENV,db));
read('consultar_viagens_de_compra','Lista viagens por situação ou detalha compras, gastos, frete e custo por pneu. Quando houver mais de uma viagem compatível, peça ao dono que identifique a viagem.',z.object({
  viagem_id:id.optional(),status:z.enum(['open','closed']).optional(),pagina:page}).strict(),
  data=>data.viagem_id?getPurchaseGroup(data.viagem_id):listPurchaseGroups(env.FAREJADOR_ENV,undefined,{page:data.pagina,status:data.status}));
write('vincular_gasto_a_viagem','Vincula uma despesa existente à viagem de compra. Use desvincular apenas quando autorizado.',z.object({
  group_id:id,expense_id:id,desvincular:z.boolean().default(false),idempotency_key:id}).strict(), async(db,data,actor)=>{
  await linkPurchaseGroupInTransaction(db,{...data,environment:env.FAREJADOR_ENV,actor,kind:'expense',record_id:data.expense_id,unlink:data.desvincular});
  return {group_id:data.group_id,expense_id:data.expense_id,vinculado:!data.desvincular};
});
read('conferir_extrato_bancario','Compara linhas de um extrato apresentado pelo dono com o caixa registrado para a conta e período. Identifica coincidências e ambiguidades.',bankInput,compareStatement);
read('simular_compra_de_lote','Estima custo unitário e impacto no caixa pelo desembolso previsto e contas abertas no período. Informe compra sem frete e frete separado.',simulationInput,simulate);
export const financeTools=[...tools.values()].map(t=>t.descriptor);
export function hasFinanceTool(name:string) {return tools.has(name);}
export async function invokeFinanceTool(identity:DotIdentity,name:string,args:unknown) {
  try {
    const data=await tools.get(name)!.call(identity,args);
    return {content:[{type:'text' as const,text:JSON.stringify(data)}],structuredContent:{...data}};
  } catch(error) {
    if(error instanceof McpError) throw error;
    const message=error instanceof Error?error.message:'';
    if (error instanceof z.ZodError) throw new McpError(ErrorCode.InvalidParams,'Confira os dados: '+error.issues.map(issue=>issue.path.join('.')||issue.code).join(', '));
    const code=/^[a-z][a-z0-9_]{2,90}$/.test(message)?message:'operacao_indisponivel';
    return {isError:true,content:[{type:'text' as const,text:'Operação não concluída. '+code}]};
  }
}
