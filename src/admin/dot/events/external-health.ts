import type { Pool } from 'pg';
import { env } from '../../../shared/config/env.js';
import type { DotSettings } from './settings.js';
import { signal,signalId } from './signal-model.js';

export const externalHealthId=signalId('farejador.sistema.atencao','external_health');
export async function readExternalHealth(db:Pool,settings:DotSettings,now:Date) {
 const external=(await db.query<{status:string;consecutive_failures:number;failing_since:Date|null;last_checked_at:Date;http_status:number|null}>(
  'SELECT status,consecutive_failures,failing_since,last_checked_at,http_status FROM ops.dot_external_health WHERE environment=$1',[env.FAREJADOR_ENV])).rows[0];
 if(!external||external.status!=='unhealthy'||external.consecutive_failures<settings.external_failures
  ||now.getTime()-external.last_checked_at.getTime()>=180000||external.last_checked_at>now)return null;
 return signal('farejador.sistema.atencao','external_health','farejador_indisponivel_confirmado_por_monitor_externo','ops.dot_external_health',
  {...external,interpretation:'Falhas consecutivas de acesso externo. Conferir host, rede e serviço.'},now,[external.failing_since]);
}
export async function recordExternalHealth(db:Pool,healthy:boolean,status:number,now:Date) {
 // A long gap breaks consecutiveness; restarts cannot turn an old isolated failure into an outage.
 await db.query(`INSERT INTO ops.dot_external_health(environment,status,consecutive_failures,failing_since,last_checked_at,http_status)
  VALUES($1,$2,CASE WHEN $3 THEN 0 ELSE 1 END,CASE WHEN $3 THEN NULL ELSE $4::timestamptz END,$4,$5)
  ON CONFLICT(environment) DO UPDATE SET status=$2,
   consecutive_failures=CASE WHEN $3 THEN 0 WHEN ops.dot_external_health.last_checked_at<$4::timestamptz-interval '3 minutes'
    THEN 1 ELSE LEAST(ops.dot_external_health.consecutive_failures+1,1000000) END,
   failing_since=CASE WHEN $3 THEN NULL WHEN ops.dot_external_health.last_checked_at<$4::timestamptz-interval '3 minutes'
    THEN $4 ELSE COALESCE(ops.dot_external_health.failing_since,$4) END,last_checked_at=$4,http_status=$5
  WHERE ops.dot_external_health.last_checked_at<$4`,[env.FAREJADOR_ENV,healthy?'healthy':'unhealthy',healthy,now,status>=100&&status<=599?status:null]);
}
