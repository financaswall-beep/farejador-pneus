import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { businessDateSaoPaulo } from '../../shared/business-time.js';
import { getMatrizLedgerOpenItems } from '../painel/matriz-ledger-open-items.js';
import { EFFECTIVE_CASH_TRANSACTION_SQL } from '../painel/matriz-effective-cash.js';
import { readDotFinance } from './finance-read.js';
import { withDotReadOnly } from './read-only.js';
import { money } from './finance-operations.js';

export const agendaInput=z.object({lado:z.enum(['a_pagar','a_receber']),busca:z.string().trim().max(100).optional(),
  pagina:z.number().int().min(1).max(10000).default(1)}).strict();
export const agenda=(data:z.infer<typeof agendaInput>)=>withDotReadOnly(async db=>{
  if(!env.MATRIZ_CENTRAL_LEDGER || !env.MATRIZ_CENTRAL_LEDGER_READ) throw Error('central_ledger_disabled');
  const group=(await getMatrizLedgerOpenItems(env.FAREJADOR_ENV,db))[data.lado];
  const needle=data.busca?.toLocaleLowerCase('pt-BR');
  const rows=group.itens.filter(r=>!needle || [r.nome,r.id,r.obligation_id,r.tipo].join(' ').toLocaleLowerCase('pt-BR').includes(needle));
  return {lado:data.lado,itens:rows.slice((data.pagina-1)*50,data.pagina*50),total_filtrado:rows.length,
    proxima_pagina:rows.length>data.pagina*50?data.pagina+1:null};
});

export const simulationInput=z.object({compra_sem_frete:money,frete:money.or(z.literal(0)),
  gastos_adicionais:money.or(z.literal(0)),coletados:z.number().int().positive().max(100000),
  aproveitaveis:z.number().int().positive().max(100000),preco_venda:money.optional(),
  desembolso_ate_a_data:money.or(z.literal(0)),ate:z.string().date()}).strict();
export const simulate=(data:z.infer<typeof simulationInput>)=>withDotReadOnly(async db=>{
  const today=businessDateSaoPaulo(new Date());
  const total=Math.round(data.compra_sem_frete*100)+Math.round(data.frete*100)+Math.round(data.gastos_adicionais*100);
  if (data.aproveitaveis>data.coletados || data.ate<today || Math.round(data.desembolso_ate_a_data*100)>total) throw Error('cenario_invalido');
  const cash=await readDotFinance(db,today.slice(0,7));
  if (!cash.available || !cash.cash) throw Error('financeiro_indisponivel');
  const open=await getMatrizLedgerOpenItems(env.FAREJADOR_ENV,db);
  const sum=(rows:typeof open.a_pagar.itens | typeof open.a_receber.itens)=>rows.reduce((n,r)=>
    n+(r.due_date && r.due_date>=today && r.due_date<=data.ate ? Math.round(Number(r.valor)*100):0),0);
  const incoming=sum(open.a_receber.itens),outgoing=sum(open.a_pagar.itens);
  const round=(n:number)=>Math.round(n)/100;
  return {simulacao:true,ate:data.ate,custo_total:total/100,custo_por_coletado:round(total/data.coletados),
    custo_por_aproveitavel:round(total/data.aproveitaveis),resultado_se_vender_todos:data.preco_venda===undefined?null:
      (Math.round(data.preco_venda*100)*data.aproveitaveis-total)/100,caixa_registrado:cash.cash.closing_brl,
    entradas_previstas:incoming/100,saidas_previstas:outgoing/100,desembolso_simulado:data.desembolso_ate_a_data,
    caixa_estimado:round(Math.round(Number(cash.cash.closing_brl)*100)+incoming-outgoing-Math.round(data.desembolso_ate_a_data*100)),
    criterio:'Considera títulos com vencimento entre hoje e a data final. A venda hipotética não compõe o caixa.',conciliacao:cash.reconciliation};
});
const bankLine=z.object({dia:z.string().date(),direcao:z.enum(['entrada','saida']),valor:money,referencia:z.string().trim().max(100).optional()}).strict();
export const bankInput=z.object({de:z.string().date(),ate:z.string().date(),conta:z.string().trim().min(2).max(80),
  movimentos:z.array(bankLine).max(200)}).strict();
export const compareStatement=(data:z.infer<typeof bankInput>)=>withDotReadOnly(async db=>{
  if(!env.MATRIZ_CENTRAL_LEDGER || !env.MATRIZ_CENTRAL_LEDGER_READ) throw Error('central_ledger_disabled');
  if (data.de>data.ate || Date.parse(data.ate)-Date.parse(data.de)>31*86400000 ||
      data.movimentos.some(m=>m.dia<data.de || m.dia>data.ate)) throw Error('intervalo_de_extrato_invalido');
  const rows=(await db.query<{id:string;dia:string;direcao:string;valor:string;conta:string|null}>(`SELECT t.id,t.cash_on::text dia,
    CASE e.side WHEN 'debit' THEN 'entrada' ELSE 'saida' END direcao,e.amount::text valor,t.metadata->>'cash_account' conta
    FROM finance.matriz_ledger_transactions t JOIN finance.matriz_reporting_entries e ON e.transaction_id=t.id AND e.environment=t.environment
    WHERE t.environment=$1 AND t.cash_on BETWEEN $2 AND $3 AND e.account_code='cash' AND `+EFFECTIVE_CASH_TRANSACTION_SQL+`
      AND (t.metadata->>'cash_account' IS NULL OR lower(t.metadata->>'cash_account')=lower($4)) ORDER BY t.cash_on,t.id LIMIT 501`,
    [env.FAREJADOR_ENV,data.de,data.ate,data.conta])).rows;
  if (rows.length>500) throw Error('reduza_o_periodo_do_extrato');
  const key=(r:{dia:string;direcao:string;valor:string|number})=>[r.dia,r.direcao,Math.round(Number(r.valor)*100)].join('/');
  const matched=new Set<string>();
  const comparacao=data.movimentos.map((m,index)=>{
    const candidates=rows.filter(r=>key(r)===key(m));
    const unique=candidates.length===1 && candidates[0]!.conta && data.movimentos.filter(other=>key(other)===key(m)).length===1;
    if (unique) matched.add(candidates[0]!.id);
    return {linha:index+1,...m,status:unique?'correspondencia_unica':candidates.length?'revisar':'somente_no_banco',
      candidatos:candidates.map(c=>c.id)};
  });
  return {de:data.de,ate:data.ate,conta:data.conta,comparacao,lancamentos_sem_correspondencia_unica:rows.filter(r=>!matched.has(r.id)),
    criterio:'Conta, dia, direção e valor. Referência do extrato é exibida para conferência.'};
});
