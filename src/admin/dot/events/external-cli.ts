import { pool } from '../../../persistence/db.js';
import { initializeDotEvents } from './worker.js';
import { runExternalCycle } from './external-cycle.js';

// Dedicated process; never imported by the application server. Same protected config, separate host.
let stopped=false,timer:NodeJS.Timeout|undefined;
for(const name of ['SIGTERM','SIGINT'] as const)process.once(name,()=>{stopped=true;if(timer)clearTimeout(timer);void pool.end();});
const state=await initializeDotEvents();
if(!state.enabled){console.error('Monitor externo indisponível:',state.reason??state.state);await pool.end();process.exitCode=1;}
else {
 const loop=async()=>{
  try{await runExternalCycle(pool);}catch{console.error('Monitor externo: verificação indisponível; conferir banco e rede.');}
  if(!stopped&&!process.argv.includes('--once'))timer=setTimeout(()=>void loop(),60000);
  else if(!stopped)await pool.end();
 };
 await loop();
}
