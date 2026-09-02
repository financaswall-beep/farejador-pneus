#!/usr/bin/env node
'use strict';

console.error('APOSENTADO: o aplicador pontual da migration 0101 não pode mais ser executado.');
console.error(
  'Use scripts/apply-migration-file.cjs com db/migrations/0101_drop_organizadora_dead_tables.sql.',
);
process.exit(1);
