import {pool} from '../persistence/db.js';
import {env} from '../shared/config/env.js';
import {marketingCreativeConfig} from '../admin/painel/queries-marketing-creatives.js';
import {marketingDateWindow} from '../admin/painel/marketing-meta.js';
import {clearGeographyMetaCache,getGeographyMeta,saveGeographyObservations} from './geography-meta.js';
export async function refreshGeographyObservations(force=false) {
  const config=marketingCreativeConfig();if(!config){if(force)throw Error('marketing_meta_not_configured');return;}
  // Deploy pode anteceder a migration: nenhuma alteração na sincronização existente.
  const ready=await pool.query("SELECT to_regclass('marketing.geography_meta_snapshots') AS relation");
  if(!ready.rows[0]?.relation){if(force)throw Object.assign(Error('migration_required'),{code:'42P01'});return;}
  if(force)clearGeographyMetaCache();
  const metadata=await getGeographyMeta(config,marketingDateWindow('30d'));
  if(metadata.state==='unavailable')throw Error('meta_geo_unavailable');
  await saveGeographyObservations(pool,env.FAREJADOR_ENV,config.adAccountId,metadata.campaigns);
}
