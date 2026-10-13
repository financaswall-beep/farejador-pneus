import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {readdirSync} from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  auditMigrationManifest,
  parseMigrationFilename,
} = require('../../../scripts/check-migrations.cjs') as {
  auditMigrationManifest: (root: string) => {
    ok: boolean;
    files: number;
    latest: string;
    errors: string[];
    documentedGaps: string[];
  };
  parseMigrationFilename: (name: string) => { order: number; suffix: string } | null;
};

describe('manifesto de migrations', () => {
  it('ordena a sequencia legada 0109, 0109b, 0109c, 0110 sem renomear o passado', () => {
    expect(parseMigrationFilename('0109_partner_push_subscriptions.sql')).toEqual({ order: 109, suffix: '' });
    expect(parseMigrationFilename('0109b_push_pk_include_unit.sql')).toEqual({ order: 109, suffix: 'b' });
    expect(parseMigrationFilename('0109c_grant_update_push_subscriptions.sql')).toEqual({ order: 109, suffix: 'c' });
    expect(parseMigrationFilename('README.md')).toBeNull();
  });

  it('cobre todos os SQL byte a byte e documenta somente o gap historico 0071', () => {
    const result = auditMigrationManifest(resolve(process.cwd()));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    const sqlFiles=readdirSync(resolve(process.cwd(),'db/migrations')).filter(file=>parseMigrationFilename(file));
    sqlFiles.sort((a,b)=>{
      const left=parseMigrationFilename(a)!,right=parseMigrationFilename(b)!;
      return left.order-right.order||left.suffix.localeCompare(right.suffix);
    });
    expect(result.files).toBe(sqlFiles.length);
    expect(result.latest).toBe(sqlFiles.at(-1));
    expect(result.documentedGaps).toEqual(['0071']);
  });
});
