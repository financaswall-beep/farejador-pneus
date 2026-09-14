import {z} from 'zod';
import type {Pool} from 'pg';
export const geographyBindingSchema=z.object({
  expected_id:z.string().regex(/^\d+$/).nullable(),
  allocation:z.enum(['dedicated','shared']),municipality:z.string().trim().min(2).max(120).nullable(),
  valid_from:z.string().date(),valid_until:z.string().date(),coverage:z.enum(['unknown','pickup','confirmed']),
  offers:z.array(z.object({ad_id:z.string().regex(/^\d{1,40}$/),measure:z.string().trim().min(3).max(40),
    brand:z.string().trim().min(1).max(100),condition:z.string().trim().min(1).max(30)}).strict()).max(30),
  reason:z.string().trim().min(3).max(500),
}).strict().superRefine((v,c)=>{
  if(v.valid_until<v.valid_from)c.addIssue({code:'custom',message:'Validade invertida'});
  if(v.allocation==='dedicated'&&!v.municipality)c.addIssue({code:'custom',message:'Informe o município'});
  if(new Set(v.offers.map(o=>JSON.stringify(o))).size!==v.offers.length)c.addIssue({code:'custom',message:'Oferta repetida'});
});
export async function saveGeographyBinding(db:Pool,environment:string,account:string,campaign:string,input:z.infer<typeof geographyBindingSchema>,actor:string) {
  const c=await db.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT pg_advisory_xact_lock(hashtext('geo_binding'),hashtext($1))",[environment+account+campaign]);
    const scope=(await c.query(`SELECT scope FROM marketing.campaign_scopes WHERE environment=$1 AND ad_account_id=$2 AND campaign_id=$3`,[environment,account,campaign])).rows[0];
    if(scope?.scope!=='matrix')throw Error('geography_scope_required');
    const latest=(await c.query(`SELECT id::text FROM marketing.geography_bindings WHERE environment=$1 AND ad_account_id=$2 AND campaign_id=$3 ORDER BY id DESC LIMIT 1`,[environment,account,campaign])).rows[0];
    if((latest?.id??null)!==input.expected_id)throw Error('geography_binding_conflict');
    for(const offer of input.offers) {
      const ad=await c.query(`SELECT 1 FROM marketing.meta_insights_daily WHERE environment=$1 AND ad_account_id=$2 AND campaign_id=$3 AND entity_level='ad' AND entity_id=$4 LIMIT 1`,[environment,account,campaign,offer.ad_id]);
      const product=await c.query(`SELECT 1 FROM commerce.products p JOIN commerce.tire_specs ts ON ts.environment=p.environment AND ts.product_id=p.id
        WHERE p.environment=$1 AND ts.tire_size=$2 AND p.brand=$3 AND p.tire_condition=$4 AND p.deleted_at IS NULL LIMIT 1`,[environment,offer.measure,offer.brand,offer.condition]);
      if(!ad.rowCount||!product.rowCount)throw Error('geography_offer_invalid');
    }
    const result=await c.query(`INSERT INTO marketing.geography_bindings(environment,ad_account_id,campaign_id,allocation,municipality,
      valid_from,valid_until,coverage,offers,reason,created_by) VALUES($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9::jsonb,$10,$11) RETURNING id::text`,
      [environment,account,campaign,input.allocation,input.municipality,input.valid_from,input.valid_until,input.coverage,JSON.stringify(input.offers),input.reason,actor]);
    await c.query('COMMIT');return result.rows[0];
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
