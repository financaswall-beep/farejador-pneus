'use strict';
// Executor específico, sem credenciais. --check/--dry-run não persistem alterações.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Client}=require('pg');
const {auditMigrationManifest}=require('./check-migrations.cjs');
const {migrationChecksum,recordApplicationMigration}=require('./migration-ledger.cjs');
const {stripEmbeddedTransactionControl}=require('./migration-compat.cjs');
const root=path.resolve(__dirname,'..'),file='0282_customer_registry.sql',mode=process.argv[2] || '--check';
const tables=['customer_registry','customer_registry_audit','customer_registry_requests'];
const project=process.env.EXPECTED_DATABASE_PROJECT;
if(!['--check','--dry-run','--commit','--verify'].includes(mode))throw Error('invalid_mode');
if(process.env.FAREJADOR_ENV!=='prod'||!project||!/^[a-z0-9]{20}$/.test(project))throw Error('explicit_production_project_required');
const target=new URL(process.env.DATABASE_URL);
if(decodeURIComponent(target.username)!==`postgres.${project}`&&target.hostname!==`db.${project}.supabase.co`)throw Error('wrong_database_project');
if(!target.hostname.endsWith('.supabase.com')&&!target.hostname.endsWith('.supabase.co'))throw Error('unexpected_database_host');
if(mode==='--commit'&&process.env.ALLOW_PROD_MIGRATION!==file)throw Error('explicit_migration_authorization_required');
const audit=auditMigrationManifest(root);if(!audit.ok)throw Error('invalid_migration_manifest');
const raw=fs.readFileSync(path.join(root,'db/migrations',file),'utf8'),checksum=migrationChecksum(raw);
const db=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000});
async function inspect(){
 const state=(await db.query('SELECT version,migration_name FROM ops.application_schema_state WHERE singleton')).rows[0];
 const ledger=(await db.query('SELECT checksum_sha256 FROM ops.applied_migrations WHERE migration_file=$1',[file])).rows[0]||null;
 const relations=(await db.query(`SELECT c.relname,c.relrowsecurity rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='commerce' AND c.relname=ANY($1) ORDER BY 1`,[tables])).rows;
 const grants=relations.length===3?(await db.query(`SELECT r.rolname,t.name,
   has_table_privilege(r.rolname,'commerce.'||t.name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed,
   has_any_column_privilege(r.rolname,'commerce.'||t.name,'SELECT,INSERT,UPDATE') columns
   FROM pg_roles r CROSS JOIN unnest($1::text[]) t(name)
   WHERE r.rolname IN ('anon','authenticated','service_role','partner_app','farejador_partner_app') ORDER BY 1,2`,[tables])).rows:[];
 return {state,ledger,tables:relations,grants};
}
function verify(state){
 assert.equal(state.ledger?.checksum_sha256,checksum);
 assert(Number(state.state?.version)>=282);
 assert.equal(state.tables.length,3);assert(state.tables.every(t=>t.rls));
 assert(!state.grants.some(g=>g.allowed||g.columns),'unexpected_public_or_partner_grants');
}
async function fingerprint(){
 const found=(await db.query(`SELECT schemaname||'.'||tablename name FROM pg_tables WHERE
   (schemaname='finance' AND tablename LIKE 'matriz_ledger_%') OR
   (schemaname='core' AND tablename='contacts') OR
   (schemaname='commerce' AND tablename IN ('customers','partner_customers','wholesale_customers','orders','partner_orders',
     'wholesale_orders','wholesale_stock','wholesale_stock_movements','tire_lots','tire_lot_movements')) ORDER BY 1`)).rows;
 const hashes={};for(const {name} of found){
  if(!/^[a-z_]+\.[a-z_]+$/.test(name))throw Error('invalid_source_table');
  hashes[name]=(await db.query(`SELECT count(*)::int count,md5(COALESCE(string_agg(h,'' ORDER BY h),'')) fingerprint
    FROM (SELECT md5(to_jsonb(t)::text) h FROM ${name} t) rows`)).rows[0];
 }return hashes;
}
(async()=>{try{
 await db.connect();await db.query(['--dry-run','--commit'].includes(mode)?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN READ ONLY');
 await db.query("SET LOCAL lock_timeout='5s'");await db.query("SET LOCAL statement_timeout='30s'");
 if(['--dry-run','--commit'].includes(mode))await db.query("SELECT pg_advisory_xact_lock(hashtextextended('farejador:migrations',0))");
 const before=await inspect();
 if(before.ledger)verify(before);
 else if(Number(before.state?.version)!==281||before.tables.length)throw Error('unexpected_schema_state');
 const prior=(await db.query("SELECT checksum_sha256 FROM ops.applied_migrations WHERE migration_file='0281_tire_stock_transfers.sql'")).rows[0];
 assert.equal(prior?.checksum_sha256,migrationChecksum(fs.readFileSync(path.join(root,'db/migrations/0281_tire_stock_transfers.sql'),'utf8')));
 let sourcesUnchanged=null;
 if(['--dry-run','--commit'].includes(mode)&&!before.ledger){
   const snapshot=await fingerprint();await db.query(stripEmbeddedTransactionControl(raw));
   assert(await recordApplicationMigration(db,file,raw,'owner_authorized_customer_registry_20261111'));
   assert.deepEqual(await fingerprint(),snapshot,'existing_business_sources_changed');sourcesUnchanged=true;
 }
 const after=await inspect();if(mode!=='--check')verify(after);
 await db.query(mode==='--commit'?'COMMIT':'ROLLBACK');
 console.log(JSON.stringify({mode,project,migration:file,checksum,before,after,
   source_rows_unchanged:sourcesUnchanged,committed:mode==='--commit',checked_at:new Date().toISOString()}));
}catch(error){await db.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({error:error.code||error.message}));process.exitCode=1;}
finally{await db.end();}})();
