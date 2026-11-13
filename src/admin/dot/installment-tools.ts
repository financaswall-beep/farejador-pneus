import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DOT_SCOPE } from './config.js';
import { env } from '../../shared/config/env.js';
import { orderSalePlanSql, type SalePaymentSnapshot } from '../painel/sale-payment-plan.js';
import { withDotReadOnly } from './read-only.js';
import { installmentReviewUrl, proposalSchema, proposeInstallment, reviewInstallment } from './installment-reviews.js';
import type { DotIdentity } from './token-store.js';

const search = 'consultar_parcelas_para_revisao';
const propose = 'preparar_alteracao_vencimento';
const status = 'consultar_proposta_vencimento';
const confirm = 'confirmar_alteracao_vencimento';
const uuid = {type:'string',format:'uuid'};
const date = {type:'string',format:'date'};
const schemes = [{type:'oauth2',scopes:[DOT_SCOPE]}];
function definition(name:string, description:string, properties:Record<string,object>,required:string[]):Tool & {securitySchemes:typeof schemes} {
  return {name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},
    annotations:{readOnlyHint:name!==propose && name!==confirm,destructiveHint:name===confirm,idempotentHint:true,openWorldHint:false},
    securitySchemes:schemes,_meta:{securitySchemes:schemes}};
}
export const installmentTools = [
  definition(search,'Localiza parcelas em aberto por nome do comprador. Se houver ambiguidade, pergunte qual venda/parcela o dono quis dizer.',
    {cliente:{type:'string',minLength:2,maxLength:120}},['cliente']),
  definition(propose,'Prepara a mudança da parcela. O resultado indica se o dono pode confirmar na conversa ou pelo link da Matriz.',
    {order_id:uuid,number:{type:'integer',minimum:1,maximum:120},expected_due_date:date,due_date:date},
    ['order_id','number','expected_due_date','due_date']),
  definition(status,'Consulta se a proposta desta conexão foi confirmada pelo dono, expirou ou está pendente.',
    {proposta:uuid},['proposta']),
];
export const confirmInstallmentTool = definition(confirm,
  'Grava o vencimento da proposta após autorização explícita do dono por voz ou texto nesta conversa. Use a proposta que corresponde à parcela e à data autorizadas.',
  {proposta:uuid,autorizado_pelo_dono:{type:'boolean',const:true}},['proposta','autorizado_pelo_dono']);

export async function invokeInstallmentTool(identity:DotIdentity,name:string,args:unknown) {
  if (!identity.installment_reviews_enabled) throw new McpError(ErrorCode.InvalidRequest,'Conexão em modo de consulta.');
  try {
    let result;
    if (name===search) {
      const {cliente}=z.object({cliente:z.string().trim().min(2).max(120)}).strict().parse(args);
      const rows=await withDotReadOnly(async db => (await db.query<{order_id:string;cliente:string;plan:SalePaymentSnapshot}>(
        `SELECT o.id order_id,c.name cliente,plan FROM commerce.wholesale_orders o JOIN commerce.wholesale_customers c
           ON c.environment=o.environment AND c.id=o.buyer_id CROSS JOIN LATERAL (SELECT ${orderSalePlanSql} AS plan) s
          WHERE o.environment=$1 AND o.status='confirmed' AND o.payment_status='pending'
            AND strpos(lower(c.name),lower($2))>0 AND (plan->>'balance')::numeric>0
          ORDER BY o.sold_at DESC,o.id LIMIT 21`,[env.FAREJADOR_ENV,cliente])).rows);
      result={truncado:rows.length>20,vendas:rows.slice(0,20).map(row=>({order_id:row.order_id,cliente:row.cliente,
        parcelas:row.plan.installments.filter(p=>p.balance>0)}))};
    } else if (name===confirm) {
      if (!identity.installment_chat_confirmation) throw new Error('dot_review_disabled');
      const {proposta}=z.object({proposta:z.string().uuid(),autorizado_pelo_dono:z.literal(true)}).strict().parse(args);
      const row=await reviewInstallment(proposta,{action:'confirm-in-chat',person:identity.person_id,grantId:identity.grant_id});
      result={status:row.status,proposta,cliente:row.buyer_name,parcela:row.installment_number,saldo:Number(row.balance),
        vencimento:row.status==='restaurado'?row.old_due:row.new_due,detalhes_url:installmentReviewUrl(proposta)};
    } else if (name===status) {
      const {proposta}=z.object({proposta:z.string().uuid()}).strict().parse(args);
      const row=await withDotReadOnly(async db=>(await db.query(`SELECT CASE WHEN restored_at IS NOT NULL THEN 'restaurado' WHEN confirmed_at IS NOT NULL
        THEN 'confirmado' WHEN expires_at<=now() THEN 'expirado' ELSE 'pendente' END status FROM network.dot_installment_reviews
        WHERE environment=$1 AND grant_id=$2 AND id=$3`,[env.FAREJADOR_ENV,identity.grant_id,proposta])).rows[0]);
      result={status:row?.status??'indisponivel'};
    } else {
      result=await proposeInstallment(identity,proposalSchema.parse(args));
    }
    return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};
  } catch(error) {
    if(error instanceof z.ZodError) throw new McpError(ErrorCode.InvalidParams,'Confira os campos, a parcela e as datas.');
    const code=(error as Error).message;
    const message=code==='installment_before_sale'?'Vencimento anterior à venda.':
      code==='dot_review_expired'?'Proposta expirada. Consulte a parcela e prepare uma nova proposta.':
      code==='dot_review_missing'?'Proposta indisponível para esta conexão. Consulte a parcela novamente.':
      code==='dot_review_disabled'||code==='dot_grant_unavailable'?'Permissão desativada.':
      code==='sale_plan_finance_required'?'Financeiro central indisponível.':
      ['sale_installment_changed','sale_not_found','central_obligation_not_open','central_obligation_not_actionable'].includes(code)?
        'A parcela mudou ou está encerrada. Consulte novamente.':'Não foi possível concluir a operação da parcela.';
    return {isError:true,content:[{type:'text' as const,text:message}]};
  }
}
