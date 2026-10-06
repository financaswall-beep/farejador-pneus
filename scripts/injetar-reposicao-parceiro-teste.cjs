'use strict';
// Demonstração operacional autorizada em parceiro.teste; nunca gera procura analítica.
// Dry-run padrão ensaia a migration e as regras em transação com ROLLBACK.
// --commit exige 0266 já aplicada e grava somente o evento de demonstração.
const fs=require('node:fs');
const {randomUUID}=require('node:crypto');
const assert=require('node:assert/strict');
const {Client}=require('pg');
const {stripEmbeddedTransactionControl}=require('./migration-compat.cjs');
const {auditMigrationManifest}=require('./check-migrations.cjs');
const commit=process.argv.includes('--commit');
const slug='teste-app-parceiro-0410';
const source='0266_partner_replenishment_demo.sql';
const target=new URL(process.env.DATABASE_URL);
if(process.env.FAREJADOR_ENV!=='prod'||target.hostname!=='aws-0-sa-east-1.pooler.supabase.com'
  ||decodeURIComponent(target.username)!=='postgres.beisgivepyfhgcujsqan') throw Error('unexpected_database');
const audit=auditMigrationManifest(process.cwd());
if(!audit.ok) throw Error('invalid_migration_manifest');
const db=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:8000});
async function snapshot(unitId) {
  return (await db.query(`SELECT
    (SELECT md5(COALESCE(string_agg(id::text||':'||quantity_on_hand||':'||quantity_reserved,',' ORDER BY id),''))
      FROM commerce.wholesale_stock WHERE environment='prod') AS warehouse,
    (SELECT md5(COALESCE(string_agg(id::text||':'||quantity_on_hand||':'||quantity_reserved,',' ORDER BY id),''))
      FROM commerce.partner_stock_levels WHERE environment='prod' AND unit_id=$1) AS local_stock,
    (SELECT count(*) FROM commerce.partner_orders WHERE environment='prod' AND unit_id=$1) AS orders,
    (SELECT count(*) FROM finance.partner_receivables WHERE environment='prod' AND unit_id=$1) AS receivables,
    (SELECT count(*) FROM finance.partner_payables WHERE environment='prod' AND unit_id=$1) AS payables,
    (SELECT count(*) FROM network.commission_entries WHERE environment='prod' AND unit_id=$1) AS commissions`,[unitId])).rows[0];
}
async function read(context,sql='SELECT * FROM commerce.partner_replenishment_offers()') {
  await db.query('SAVEPOINT partner_read');
  try {
    await db.query("SELECT set_config('app.partner_unit_id',$1,true)",[context||'']);
    return (await db.query(sql)).rows;
  } finally {await db.query('ROLLBACK TO SAVEPOINT partner_read');await db.query('RELEASE SAVEPOINT partner_read');}
}
async function event(unitId,payload,age='0 seconds',environment='prod') {
  const id=randomUUID();
  await db.query(`INSERT INTO audit.events
    (id,environment,domain,entity_table,entity_id,event_type,actor_label,idempotency_key,payload_after,created_at)
    VALUES ($1,$2,'network','network.partner_units',$3,'partner_replenishment_demo_created',$4,$5,$6::jsonb,now()-$7::interval)`,
    [id,environment,unitId,'Demonstração de reposição solicitada pelo proprietário',
      'partner-replenishment-demo:'+id,JSON.stringify(payload),age]);
  return id;
}
async function main() {
 await db.connect();
 try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await db.query("SET LOCAL statement_timeout='15s'");
  const unit=(await db.query(`SELECT pu.id,pu.unit_id FROM network.partner_units pu
    JOIN network.partners p ON p.id=pu.partner_id AND p.environment=pu.environment
    WHERE pu.environment='prod' AND pu.slug=$1 AND pu.status='active' AND p.status='active'
      AND pu.deleted_at IS NULL AND p.deleted_at IS NULL AND NOT pu.accepts_network_orders AND p.commission_percent=0
      AND EXISTS(SELECT 1 FROM network.partner_access_tokens t WHERE t.environment=pu.environment
        AND t.partner_unit_id=pu.id AND t.login_username='parceiro.teste' AND t.role='owner' AND t.revoked_at IS NULL)`,[slug])).rows[0];
  if(!unit) throw Error('test_account_guard_failed');
  if(!commit) await db.query(stripEmbeddedTransactionControl(fs.readFileSync('db/migrations/'+source,'utf8')));
  else if(!(await db.query("SELECT to_regprocedure('commerce.partner_replenishment_live_offers()') IS NOT NULL AS ready")).rows[0].ready) throw Error('migration_0266_required');
  if((await read(unit.id,'SELECT * FROM commerce.partner_replenishment_live_offers()')).length) throw Error('test_account_has_real_replenishment');
  const baseline=await read(unit.id);
  const before=await snapshot(unit.unit_id);
  const candidates=(await db.query(`SELECT w.measure,w.tire_condition,
    sum(w.quantity_on_hand-w.quantity_reserved)::int AS quantity_available
    FROM commerce.wholesale_stock w WHERE w.environment='prod' AND w.quantity_on_hand>w.quantity_reserved
      AND NOT EXISTS(SELECT 1 FROM commerce.partner_stock_levels s WHERE s.environment=w.environment AND s.unit_id=$1
        AND s.deleted_at IS NULL AND s.is_tracked AND s.quantity_on_hand-COALESCE(s.quantity_reserved,0)>0
        AND s.tire_condition=w.tire_condition AND commerce.wholesale_measure_key(s.tire_size)=commerce.wholesale_measure_key(w.measure))
    GROUP BY w.measure,w.tire_condition ORDER BY quantity_available DESC,w.measure LIMIT 3`,[unit.unit_id])).rows;
  if(!candidates.length) throw Error('warehouse_has_no_eligible_demo_stock');
  const payload={simulation:true,reason:'Visualização solicitada pelo proprietário; contagens de procura fictícias',
    measures:candidates.map((w,i)=>({measure:w.measure,tire_condition:w.tire_condition,demand_count:candidates.length+1-i}))};
  if(!commit) {
    for(const [kind,data,age,environment] of [
      ['expired',payload,'3 hours','prod'],['future',payload,'-1 hour','prod'],
      ['other_environment',payload,'0 seconds','test'],['missing_marker',{measures:payload.measures},'0 seconds','prod'],
      ['empty',{simulation:true,measures:[]},'0 seconds','prod']]) {
      await db.query('SAVEPOINT negative'); await event(unit.id,data,age,environment);
      assert.deepEqual(await read(unit.id),['expired','future','other_environment'].includes(kind)?baseline:[]);
      await db.query('ROLLBACK TO SAVEPOINT negative');
      await db.query('RELEASE SAVEPOINT negative'); console.log(JSON.stringify({check:kind,passed:true}));
    }
  }
  const id=await event(unit.id,payload);
  const rows=await read(unit.id);
  assert.equal(new Set(rows.map(w=>w.measure)).size,new Set(candidates.map(w=>w.measure)).size);
  for(const candidate of candidates) assert.equal(rows.filter(w=>w.measure===candidate.measure&&w.tire_condition===candidate.tire_condition)
    .reduce((n,w)=>n+w.quantity_available,0),candidate.quantity_available);
  assert.deepEqual(await read(null),[]);
  const grants=(await db.query(`SELECT
    has_function_privilege('farejador_partner_app','commerce.partner_replenishment_offers()','EXECUTE') AS public_offer,
    has_function_privilege('farejador_partner_app','commerce.partner_replenishment_live_offers()','EXECUTE') AS private_offer,
    has_table_privilege('farejador_partner_app','audit.events','SELECT') AS audit_read`)).rows[0];
  assert.deepEqual(grants,{public_offer:true,private_offer:false,audit_read:false});
  assert.deepEqual(await snapshot(unit.unit_id),before);
  await db.query(commit?'COMMIT':'ROLLBACK');
  console.log(JSON.stringify({committed:commit,account:'parceiro.teste',eventId:commit?id:null,expiresInHours:2,
    measures:candidates.map(w=>w.measure),stockChanged:false,financeChanged:false,scopeAndPermissionsVerified:true}));
 } catch(error) {await db.query('ROLLBACK').catch(()=>{});throw error;} finally {await db.end();}
}
main().catch(e=>{console.error(JSON.stringify({error:e.code||e.message,message:e.message,where:e.where}));process.exitCode=1;});
