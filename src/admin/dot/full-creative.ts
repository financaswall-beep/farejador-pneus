import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { getMetaCreatives,safeMetaImageUrl } from '../../marketing/meta-creatives.js';
import { marketingCreativeConfig } from '../painel/queries-marketing-creatives.js';
import { withDotReadOnly } from './read-only.js';
export const creativeInput=z.object({anuncio_id:z.string().regex(/^\d{1,40}$/)}).strict();
/** The panel already reads these fields live. Only an owned, verified ad is eligible. */
export async function readFullCreative(raw:unknown) {
  const input=creativeInput.parse(raw),config=marketingCreativeConfig();
  if(!config)return {available:false,reason:'marketing_meta_not_configured'};
  const owned=await withDotReadOnly(async db=>(await db.query(`SELECT 1 FROM marketing.meta_ad_identities a
    JOIN marketing.meta_identity_accounts i ON i.environment=a.environment AND i.ad_account_id=a.ad_account_id
    WHERE a.environment=$1 AND a.ad_account_id=$2 AND a.ad_id=$3 AND a.scope='matrix'`,
  [env.FAREJADOR_ENV,config.adAccountId,input.anuncio_id])).rows.length>0);
  if(!owned)throw Error('creative_not_owned_or_not_found');
  const result=await getMetaCreatives(config,[input.anuncio_id]),ad=result.ads[0];
  if(!ad)return {available:false,reason:'creative_provider_unavailable'};
  return {available:true,source:'Meta (consulta ao provedor)',anuncio:{id:ad.id,nome:ad.name,titulo:ad.title,
    texto:ad.body,formato:ad.format,status:ad.status,imagem_url:safeMetaImageUrl(ad.image_url)},
    aviso:'Texto e imagem do anúncio próprio. Nenhuma publicação, sincronização ou alteração foi executada.'};
}
