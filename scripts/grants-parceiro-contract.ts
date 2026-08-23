import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { QueryResult, QueryResultRow } from 'pg';

export const PARTNER_DATABASE_ROLE = 'farejador_partner_app';

interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
}

interface GrantRow extends QueryResultRow {
  table_schema: string;
  table_name: string;
  privilege_type: string;
  is_grantable: 'YES' | 'NO';
}

interface RoleRow extends QueryResultRow {
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolinherit: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
}

export interface SensitivePrivilege extends QueryResultRow {
  relation: string;
  scope: 'table' | 'column';
  privilege: string;
}

export interface PartnerGrantBaseline {
  version: number;
  role: string;
  canonicalization: string;
  expected_count: number;
  expected_sha256: string;
  grants: string[];
}

export interface PartnerGrantAudit {
  ok: boolean;
  roleExists: boolean;
  roleSafe: boolean;
  roleViolations: string[];
  baselineValid: boolean;
  expectedCount: number;
  actualCount: number;
  expectedSha256: string;
  actualSha256: string;
  missingGrants: string[];
  unexpectedGrants: string[];
  sensitivePrivileges: SensitivePrivilege[];
}

const BASELINE_URL = new URL('./baseline-grants-parceiro.json', import.meta.url);

export function hashGrantLines(lines: string[]): string {
  return createHash('sha256')
    .update([...lines].sort().join('\n'), 'utf8')
    .digest('hex');
}

export async function loadPartnerGrantBaseline(): Promise<PartnerGrantBaseline> {
  return JSON.parse(await readFile(BASELINE_URL, 'utf8')) as PartnerGrantBaseline;
}

function canonicalGrant(row: GrantRow): string {
  return `${row.table_schema}.${row.table_name}:${row.privilege_type}:${row.is_grantable}`;
}

function inspectRole(row: RoleRow | undefined): string[] {
  if (!row) return ['role ausente'];
  const violations: string[] = [];
  if (!row.rolcanlogin) violations.push('NOLOGIN');
  if (row.rolsuper) violations.push('SUPERUSER');
  if (row.rolinherit) violations.push('INHERIT');
  if (row.rolcreaterole) violations.push('CREATEROLE');
  if (row.rolcreatedb) violations.push('CREATEDB');
  if (row.rolreplication) violations.push('REPLICATION');
  if (row.rolbypassrls) violations.push('BYPASSRLS');
  return violations;
}

async function readSensitivePrivileges(db: Queryable): Promise<SensitivePrivilege[]> {
  const result = await db.query<SensitivePrivilege>(`
    WITH sensitive_relations AS (
      SELECT c.oid, n.nspname, c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND (
           (n.nspname = 'commerce' AND c.relname ~ '^(wholesale_|matriz_)')
           OR (n.nspname = 'network' AND c.relname IN ('commission_entries', 'commission_entry_events'))
           OR (n.nspname = 'finance' AND c.relname ~ '^matriz_ledger_')
         )
    ), effective_privileges AS (
      SELECT format('%I.%I', nspname, relname) AS relation,
             privilege.scope,
             privilege.name AS privilege,
             privilege.allowed
        FROM sensitive_relations
        CROSS JOIN LATERAL (VALUES
          ('table',  'SELECT',     has_table_privilege($1, oid, 'SELECT')),
          ('table',  'INSERT',     has_table_privilege($1, oid, 'INSERT')),
          ('table',  'UPDATE',     has_table_privilege($1, oid, 'UPDATE')),
          ('table',  'DELETE',     has_table_privilege($1, oid, 'DELETE')),
          ('table',  'TRUNCATE',   has_table_privilege($1, oid, 'TRUNCATE')),
          ('table',  'REFERENCES', has_table_privilege($1, oid, 'REFERENCES')),
          ('table',  'TRIGGER',    has_table_privilege($1, oid, 'TRIGGER')),
          ('column', 'SELECT',     has_any_column_privilege($1, oid, 'SELECT')),
          ('column', 'INSERT',     has_any_column_privilege($1, oid, 'INSERT')),
          ('column', 'UPDATE',     has_any_column_privilege($1, oid, 'UPDATE')),
          ('column', 'REFERENCES', has_any_column_privilege($1, oid, 'REFERENCES'))
        ) AS privilege(scope, name, allowed)
    )
    SELECT relation, scope, privilege
      FROM effective_privileges
     WHERE allowed
     ORDER BY relation, scope, privilege
  `, [PARTNER_DATABASE_ROLE]);
  return result.rows;
}

export async function auditPartnerGrants(db: Queryable): Promise<PartnerGrantAudit> {
  const baseline = await loadPartnerGrantBaseline();
  const baselineHash = hashGrantLines(baseline.grants);
  const baselineValid = baseline.role === PARTNER_DATABASE_ROLE
    && baseline.expected_count === baseline.grants.length
    && baseline.expected_sha256 === baselineHash
    && new Set(baseline.grants).size === baseline.grants.length;

  const roleResult = await db.query<RoleRow>(`
    SELECT rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
           rolreplication, rolbypassrls
      FROM pg_roles
     WHERE rolname = $1
  `, [PARTNER_DATABASE_ROLE]);
  const roleViolations = inspectRole(roleResult.rows[0]);

  const grantResult = await db.query<GrantRow>(`
    SELECT table_schema, table_name, privilege_type, is_grantable
      FROM information_schema.role_table_grants
     WHERE grantee = $1
     ORDER BY table_schema, table_name, privilege_type, is_grantable
  `, [PARTNER_DATABASE_ROLE]);
  const actualGrants = grantResult.rows.map(canonicalGrant).sort();
  const expected = new Set(baseline.grants);
  const actual = new Set(actualGrants);
  const missingGrants = baseline.grants.filter((grant) => !actual.has(grant));
  const unexpectedGrants = actualGrants.filter((grant) => !expected.has(grant));
  const sensitivePrivileges = roleResult.rowCount === 1
    ? await readSensitivePrivileges(db)
    : [];

  const audit: PartnerGrantAudit = {
    ok: false,
    roleExists: roleResult.rowCount === 1,
    roleSafe: roleViolations.length === 0,
    roleViolations,
    baselineValid,
    expectedCount: baseline.expected_count,
    actualCount: actualGrants.length,
    expectedSha256: baseline.expected_sha256,
    actualSha256: hashGrantLines(actualGrants),
    missingGrants,
    unexpectedGrants,
    sensitivePrivileges,
  };
  audit.ok = audit.roleSafe
    && audit.baselineValid
    && audit.actualCount === audit.expectedCount
    && audit.actualSha256 === audit.expectedSha256
    && audit.missingGrants.length === 0
    && audit.unexpectedGrants.length === 0
    && audit.sensitivePrivileges.length === 0;
  return audit;
}
