import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { MATRIZ_COORD,DEFAULT_MATRIZ_FREIGHT } from '../../atendente-v2/matriz-freight.js';
import { readDeliverySettings,deliverySettingsSchema,type DeliverySettings } from '../../atendente-v2/matriz-delivery-settings.js';

export async function getBotDeliveryConfig(db:Pool=pool) {
  const saved=await readDeliverySettings(db,env.FAREJADOR_ENV);
  const address=await db.query<{policy_value:unknown}>(`SELECT policy_value FROM commerce.store_policies
    WHERE environment=$1 AND policy_key='endereco' AND is_active=true ORDER BY updated_at DESC LIMIT 1`,[env.FAREJADOR_ENV]);
  const value=address.rows[0]?.policy_value;
  return { version:saved?.version??0,updated_at:saved?.updated_at??null,configured:!!saved,
    settings:saved?.settings??{delivery_enabled:true,pickup_enabled:true,radius_km:null,freight:{...DEFAULT_MATRIZ_FREIGHT},
      address:typeof value==='string'?value:'Matriz · São Gonçalo',latitude:MATRIZ_COORD.lat,longitude:MATRIZ_COORD.lng,
      days:[],opens_at:null,closes_at:null,delivery_days:null},
    maps_browser_key:env.GOOGLE_MAPS_BROWSER_API_KEY??null,
    routing:{geo:env.ROUTING_GEO,proximity:env.ROUTING_PROXIMITY_FIRST,matriz_competes:env.ROUTING_MATRIZ_COMPETES&&env.WHOLESALE_UNIFIED_STOCK,
      road_distance:env.ROUTING_GEO_ROAD_DISTANCE},
  };
}
export async function saveBotDeliveryConfig(settings:DeliverySettings,expectedVersion:number,actor:string,db:Pool=pool) {
  const value=deliverySettingsSchema.parse(settings);
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    // Serializa o primeiro cadastro também, quando ainda não existe uma linha para bloquear.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('matriz_delivery'),hashtext($1))",[env.FAREJADOR_ENV]);
    const previous=await readDeliverySettings(client,env.FAREJADOR_ENV);
    if ((previous?.version??0)!==expectedVersion) throw new Error('delivery_settings_conflict');
    const result=await client.query<{version:number;updated_at:Date}>(`INSERT INTO commerce.matriz_delivery_settings
      (environment,settings,version,updated_by) VALUES ($1,$2::jsonb,$3,$4)
      ON CONFLICT (environment) DO UPDATE SET settings=EXCLUDED.settings,version=EXCLUDED.version,
      updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING version,updated_at`,
      [env.FAREJADOR_ENV,JSON.stringify(value),expectedVersion+1,actor]);
    await client.query(`INSERT INTO commerce.matriz_delivery_settings_events(environment,version,settings,actor)
      VALUES ($1,$2,$3::jsonb,$4)`,[env.FAREJADOR_ENV,expectedVersion+1,JSON.stringify(value),actor]);
    await client.query('COMMIT');
    return {settings:value,version:result.rows[0]!.version,updated_at:result.rows[0]!.updated_at,configured:true};
  } catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
}
