// MODALIDADES de despesa da matriz (0130): as 6 de fábrica (is_system) + as que o
// dono cadastra ("Pedágio", "Alimentação"…). A 0120 travava a categoria num CHECK
// de 6 valores e tudo que não encaixava virava "outros"; agora a lista é viva —
// a integridade continua no BANCO (FK composta environment+slug, RESTRICT).
// Modalidade nunca se apaga: ARQUIVA (some do form; despesa antiga fica íntegra).
// Dado SÓ da matriz — zero grant pro parceiro (provado na 0130).
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

export interface MatrizExpenseCategoryRow {
  id: string;         // slug normalizado ('pedagio') — o front já usa {id,label} desde a 0120
  label: string;      // rótulo da tela ('Pedágio')
  is_system: boolean; // de fábrica: não arquivável ('outros' é o fallback da IA de comprovante)
  archived: boolean;  // arquivada: fora do form de lançar; rótulo continua valendo
}

/** Nome que o dono digita → slug: sem acento, minúsculo, '_' como separador.
 *  "Alimentação da equipe" → 'alimentacao_da_equipe'. Vazio/curto demais → ''. */
export function normalizeCategorySlug(label: string): string {
  const slug = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/, '');
  return slug.length >= 2 ? slug : '';
}

/** TODAS as modalidades do env (ativas primeiro: fábrica → custom por nome; arquivadas
 *  no fim). A lista inteira serve o RÓTULO de despesa antiga; o form filtra archived. */
export async function listMatrizExpenseCategories(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizExpenseCategoryRow[]> {
  const r = await dbPool.query<MatrizExpenseCategoryRow>(
    `SELECT slug AS id, label, is_system, (archived_at IS NOT NULL) AS archived
       FROM commerce.matriz_expense_categories
      WHERE environment = $1
      ORDER BY (archived_at IS NOT NULL), is_system DESC, label`,
    [environment],
  );
  return r.rows;
}

/** Só os slugs ATIVOS — é o vocabulário válido da IA de comprovante e do guard de lançamento. */
export async function listActiveExpenseCategorySlugs(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<Array<{ id: string; label: string }>> {
  const r = await dbPool.query<{ id: string; label: string }>(
    `SELECT slug AS id, label FROM commerce.matriz_expense_categories
      WHERE environment = $1 AND archived_at IS NULL
      ORDER BY is_system DESC, label`,
    [environment],
  );
  return r.rows;
}

/** Cadastra uma modalidade nova. Mesmo nome já ATIVO → 'category_exists'.
 *  Mesmo nome ARQUIVADO → REATIVA (o "criei de novo" do dono desfaz o arquivar). */
export async function createMatrizExpenseCategory(
  input: { label: string; created_by?: string | null; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<MatrizExpenseCategoryRow> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const label = input.label.trim();
  const slug = normalizeCategorySlug(label);
  if (!slug || label.length < 2 || label.length > 40) throw new Error('category_label_invalid');
  const r = await dbPool.query<MatrizExpenseCategoryRow>(
    `INSERT INTO commerce.matriz_expense_categories (environment, slug, label, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (environment, slug) DO UPDATE
        SET archived_at = NULL, label = EXCLUDED.label
      WHERE matriz_expense_categories.archived_at IS NOT NULL
     RETURNING slug AS id, label, is_system, (archived_at IS NOT NULL) AS archived`,
    [environment, slug, label, input.created_by ?? null],
  );
  // ON CONFLICT com WHERE falso (já existe E está ativa) não retorna linha → nome em uso.
  if (!r.rows[0]) throw new Error('category_exists');
  return r.rows[0];
}

/** Arquiva uma modalidade CUSTOM (fábrica não arquiva — 'outros' é fallback da IA).
 *  Despesa antiga não muda; a modalidade só some do form de lançar. */
export async function archiveMatrizExpenseCategory(
  slug: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ id: string }> {
  const r = await dbPool.query<{ id: string }>(
    `UPDATE commerce.matriz_expense_categories
        SET archived_at = now()
      WHERE environment = $1 AND slug = $2 AND is_system = false AND archived_at IS NULL
      RETURNING slug AS id`,
    [environment, slug],
  );
  if (!r.rows[0]) throw new Error('category_not_archivable');
  return r.rows[0];
}
