import type { PoolClient } from 'pg';
import { z } from 'zod';

import { env } from '../../shared/config/env.js';
import {
  createMatrizExpenseCategory,
  listActiveExpenseCategorySlugs,
  listMatrizExpenseCategories,
  normalizeCategorySlug,
} from '../painel/queries-despesas-categorias.js';
import { matrizExpenseCategoryCreateSchema } from '../painel/route-schemas-expenses.js';
import { recordIntegrityEvent } from '../painel/stage5-integrity.js';
import { activeExpenseForReclassification, reclassifyExpense } from '../painel/expense-reclassification.js';
import { id } from './finance-operations.js';

export class ExpenseCategoryNotice extends Error {
  constructor(readonly details: Record<string, unknown>) {
    super(String(details.status));
  }
}

const energySlugs = new Set(['energia', 'energia_eletrica', 'luz', 'conta_de_luz', 'conta_de_energia', 'conta_de_energia_eletrica']);
function categoryKey(value: string): string {
  const slug = normalizeCategorySlug(value);
  return energySlugs.has(slug) ? 'energia' : slug;
}

function requireExpenses() {
  if (!env.MATRIZ_EXPENSES) throw new Error('expenses_disabled');
}

export async function activeExpenseCategories() {
  requireExpenses();
  return { categorias: await listActiveExpenseCategorySlugs() };
}

export async function requireActiveExpenseCategory(db: PoolClient, slug: string) {
  requireExpenses();
  const { rows: [category] } = await db.query<{ id: string; label: string }>(
    `SELECT slug AS id,label FROM commerce.matriz_expense_categories
      WHERE environment=$1 AND slug=$2 AND archived_at IS NULL FOR SHARE`,
    [env.FAREJADOR_ENV, slug],
  );
  if (!category) {
    const active = await listActiveExpenseCategorySlugs(env.FAREJADOR_ENV, db);
    throw new ExpenseCategoryNotice({
      status: 'categoria_indisponivel',
      executada: false,
      categoria_solicitada: slug,
      categorias_ativas: active,
      instrucao: 'Escolha uma categoria ativa ou prepare a criação da categoria antes de pedir autorização para a despesa.',
    });
  }
  return category;
}

export const newExpenseCategorySchema = matrizExpenseCategoryCreateSchema.extend({ idempotency_key: id }).strict();
type NewCategory = z.infer<typeof newExpenseCategorySchema>;
export async function previewNewExpenseCategory(db: PoolClient, data: NewCategory) {
  requireExpenses();
  const environment = env.FAREJADOR_ENV;
  const key = categoryKey(data.label);
  if (!key) throw new Error('category_label_invalid');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`matriz-expense-category:${environment}:${key}`]);
  const categories = await listMatrizExpenseCategories(environment, db);
  const equivalents = categories.filter((category) => [categoryKey(category.id), categoryKey(category.label)].includes(key));
  const existing = equivalents.find((category) => !category.archived);
  if (existing) {
    throw new ExpenseCategoryNotice({
      status: 'categoria_existente', executada: false, categoria: { id: existing.id, label: existing.label },
    });
  }
  const slug = normalizeCategorySlug(data.label);
  const archived = equivalents.find((category) => category.id === slug) ?? equivalents[0];
  return {
    acao: archived ? 'reativar' : 'criar',
    categoria: archived ? { id: archived.id, label: archived.label } : { id: slug, label: data.label },
  };
}

export async function saveExpenseCategory(db: PoolClient, data: NewCategory, actor: string) {
  const plan = await previewNewExpenseCategory(db, data);
  const category = await createMatrizExpenseCategory({
    label: plan.categoria.label, slug: plan.categoria.id, created_by: actor,
  }, db);
  await db.query(
    `INSERT INTO audit.events (environment,domain,entity_table,event_type,actor_label,idempotency_key,payload_after)
       VALUES ($1,'matriz_expense','commerce.matriz_expense_categories',$2,$3,$4,$5::jsonb)`,
    [env.FAREJADOR_ENV, plan.acao === 'reativar' ? 'expense_category_reactivated' : 'expense_category_created',
      actor, data.idempotency_key, JSON.stringify(category)],
  );
  return { categoria: category, acao: plan.acao };
}

export const reclassifyExpenseSchema = z.object({
  expense_id: id,
  category: z.string().regex(/^[a-z0-9_]{2,40}$/),
  reason: z.string().trim().min(2).max(300).optional(),
  idempotency_key: id,
}).strict();
type Reclassify = z.infer<typeof reclassifyExpenseSchema>;

export async function previewExpenseReclassification(db: PoolClient, data: Reclassify) {
  const category = await requireActiveExpenseCategory(db, data.category);
  const current = await activeExpenseForReclassification(db, env.FAREJADOR_ENV, data.expense_id, data.category);
  if (current.categoria_atual.id === category.id) {
    throw new ExpenseCategoryNotice({ status: 'categoria_inalterada', executada: false, categoria: category });
  }
  return { ...current, categoria_nova: category, alteracao_caixa: 0, alteracao_resultado_total: 0 };
}

export async function saveExpenseReclassification(db: PoolClient, data: Reclassify, actor: string) {
  const plan = await previewExpenseReclassification(db, data);
  await reclassifyExpense(db, env.FAREJADOR_ENV, data.expense_id, plan.categoria_atual.id, data.category);
  await recordIntegrityEvent(db, {
    environment: env.FAREJADOR_ENV, domain: 'matriz_expense', entityTable: 'commerce.matriz_expenses',
    entityId: data.expense_id, eventType: 'expense_category_changed', actorLabel: actor,
    idempotencyKey: data.idempotency_key,
    before: { category: plan.categoria_atual.id },
    after: { category: plan.categoria_nova.id, reason: data.reason ?? null },
  });
  return { ...plan, expense_id: data.expense_id };
}
