import { env } from '../../shared/config/env.js';

const running=new Map<string,number>();
let total=0;
/** Leave pool capacity for the store, bot and ingestion. Admission has no unbounded queue. */
export function acquireDotRequest(grantId:string):(()=>void)|null {
  const max=Math.max(1,Math.min(3,Math.floor(env.DATABASE_POOL_MAX/2)));
  const count=running.get(grantId)??0;
  if(total>=max||count>=2)return null;
  running.set(grantId,count+1);total++;
  let released=false;
  return ()=>{
    if(released)return;
    released=true;total--;
    const next=(running.get(grantId)??1)-1;
    if(next)running.set(grantId,next);else running.delete(grantId);
  };
}
