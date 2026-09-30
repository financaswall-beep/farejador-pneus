import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import type {Pool} from 'pg';
import {recordViewObservation,latestViewObservations,dailyViewHistory} from '../../src/marketing/organic/metric-history.js';
import {startPostgres,stopPostgres,type IntegrationDb} from './helpers/postgres.js';
let embedded:any,container:IntegrationDb|undefined,pool:Pool;
beforeAll(async()=>{
  if(process.env.PUBLISHER_EMBEDDED_DB==='1'){
    const {PGlite}=await import(pathToFileURL(resolve('artifacts/publisher-validation/node_modules/@electric-sql/pglite/dist/index.js')).href);
    embedded=new PGlite();
    await embedded.exec("CREATE TYPE env_t AS ENUM('prod','test');CREATE SCHEMA analytics;CREATE ROLE farejador_partner_app;");
    pool={query:async(sql:string,args?:any[])=>embedded.query(sql,args)} as unknown as Pool;
  }else{container=await startPostgres({throughMigration:'0247_marketing_publisher_recovery.sql'});pool=container.pool;}
  const sql=await readFile('db/migrations/0248_organic_metric_history.sql','utf8');
  if(embedded)await embedded.exec(sql);else await pool.query(sql);
},180000);
afterAll(async()=>{if(embedded)await embedded.close();if(container)await stopPostgres(container);});
const ref={platform:'instagram' as const,account_id:'200',post_id:'301'};
it('isola ambiente/conta/post, deduplica a mesma coleta e preserva contadores zero e ausentes',async()=>{
  const now=new Date().toISOString();
  for(const [environment,account_id,views] of [['prod','200',100],['test','200',0],['test','999',999]] as const){
    await recordViewObservation(pool,environment,{...ref,account_id,views,observed_at:now,metric:'views'});
  }
  await recordViewObservation(pool,'test',{...ref,views:400,observed_at:now,metric:'views'});
  expect((await latestViewObservations(pool,'test',[ref]))[0]!.views).toBe(0);
  expect((await latestViewObservations(pool,'prod',[ref]))[0]!.views).toBe(100);
  expect(await latestViewObservations(pool,'test',[{...ref,post_id:'other'}])).toEqual([]);
});
it('mantém imutabilidade e impede acesso do portal parceiro',async()=>{
  await expect(pool.query("UPDATE analytics.organic_metric_observations SET views=500 WHERE environment='test'")).rejects.toThrow('organic_metric_observation_immutable');
  const result=await pool.query(`SELECT relrowsecurity,has_table_privilege('farejador_partner_app',oid,'SELECT') readable
    FROM pg_class WHERE oid='analytics.organic_metric_observations'::regclass`);
  expect(result.rows[0]).toMatchObject({relrowsecurity:true,readable:false});
});
it('seleciona a última observação real de cada dia em Brasília, sem preencher os dias ausentes',async()=>{
  const end=new Date();end.setUTCHours(2,30,0,0);
  const first=new Date(end.getTime()-86400000);
  const second=new Date(first.getTime()+15*60000);
  const other={...ref,post_id:'daily'};
  await recordViewObservation(pool,'test',{...other,observed_at:first.toISOString(),views:120,metric:'views'});
  await recordViewObservation(pool,'test',{...other,observed_at:second.toISOString(),views:90,metric:'views'});
  await recordViewObservation(pool,'test',{...other,observed_at:end.toISOString(),views:null,metric:'views'});
  const rows=await dailyViewHistory(pool,'test',[other],7);
  expect(rows).toHaveLength(2);
  expect(rows.map(r=>r.views)).toEqual([90,null]);
  expect(rows[0]!.date).toBe(new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(first));
});
