import type {PoolClient} from 'pg';
import {env} from '../../shared/config/env.js';
import {insertMatrizExpenseInTransaction} from '../painel/queries-financeiro-despesas-integridade.js';
import {assertHistorical,type Trip} from './retail-delivery-schemas.js';

type Expense=Trip['expenses'][number];
export async function tripExpense(db:PoolClient,item:Expense) {
  if ('expense_id' in item) {
    const e=(await db.query(`SELECT e.id,e.category,e.amount::float8 AS amount,e.description,e.delivery_trip_id,e.occurred_at,e.payment_status,
      (EXISTS(SELECT 1 FROM commerce.matriz_trip_receipts r WHERE r.environment=e.environment AND r.ai_expense_id=e.id)
       OR EXISTS(SELECT 1 FROM commerce.matriz_trip_lost_receipts r WHERE r.environment=e.environment AND r.expense_id=e.id)
       OR EXISTS(SELECT 1 FROM commerce.matriz_delivery_trips t WHERE t.environment=e.environment AND t.fuel_expense_id=e.id)
       OR EXISTS(SELECT 1 FROM commerce.wholesale_purchase_group_expenses g WHERE g.environment=e.environment AND g.expense_id=e.id)) AS vinculada
      FROM commerce.matriz_expenses e WHERE e.environment=$1 AND e.id=$2 AND e.deleted_at IS NULL FOR UPDATE OF e`,
      [env.FAREJADOR_ENV,item.expense_id])).rows[0];
    if (!e) throw Error('despesa_nao_encontrada');
    if (e.delivery_trip_id || e.vinculada) throw Error('despesa_ja_vinculada');
    return {id:e.id as string,category:e.category as string,amount:e.amount as number,description:e.description as string,occurred_at:new Date(e.occurred_at).toISOString(),situacao:e.payment_status as string,acao:'vincular'};
  }
  assertHistorical(item.occurred_at);
  const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date(item.occurred_at));
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[[env.FAREJADOR_ENV,day,item.category,item.amount].join('|')]);
  const duplicate=await db.query(`SELECT id FROM commerce.matriz_expenses WHERE environment=$1 AND category=$2 AND amount=$3
    AND (occurred_at AT TIME ZONE 'America/Sao_Paulo')::date=$4::date AND deleted_at IS NULL LIMIT 1`,
  [env.FAREJADOR_ENV,item.category,item.amount,day]);
  if (duplicate.rowCount) throw Error('despesa_parecida_encontrada_consulte_e_vincule_pelo_id');
  const category=await db.query('SELECT 1 FROM commerce.matriz_expense_categories WHERE environment=$1 AND slug=$2 AND archived_at IS NULL',
    [env.FAREJADOR_ENV,item.category]);
  if (!category.rowCount) throw Error('category_invalid');
  return {id:null,category:item.category,amount:item.amount,description:item.description,occurred_at:item.occurred_at,situacao:'paid',acao:'lancar'};
}
export async function applyTripExpenses(db:PoolClient,expenses:Expense[],tripId:string,actor:string) {
  for (const item of expenses) {
    const id='expense_id' in item ? item.expense_id : (await insertMatrizExpenseInTransaction(db,{
      ...item,environment:env.FAREJADOR_ENV,payment_status:'paid',paid_at:item.occurred_at,created_by:actor,
    })).id;
    const linked=await db.query(`UPDATE commerce.matriz_expenses SET delivery_trip_id=$3
      WHERE environment=$1 AND id=$2 AND delivery_trip_id IS NULL AND deleted_at IS NULL`,[env.FAREJADOR_ENV,id,tripId]);
    if (linked.rowCount!==1) throw Error('despesa_ja_vinculada');
  }
}
