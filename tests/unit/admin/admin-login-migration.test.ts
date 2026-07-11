import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('0132 matriz admin login migration', () => {
  it('adds explicit roles while preserving default-deny for partner database role', async () => {
    const sql = await readFile(path.join(process.cwd(), 'db', 'migrations', '0132_matriz_admin_login.sql'), 'utf8');

    expect(sql).toContain("panel_role IN ('owner', 'admin')");
    expect(sql).toContain("panel_role IS NULL");
    expect(sql).toContain("has_table_privilege('farejador_partner_app'");
    expect(sql).not.toMatch(/GRANT\s+.+matriz_(collaborators|staff_sessions)/i);
  });
});
