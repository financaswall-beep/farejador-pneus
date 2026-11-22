import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {env} from '../../shared/config/env.js';
import {getAdminContext} from '../auth.js';
import {dotHumanOwner} from './route-oauth.js';
import {lockGrant,transact} from './installment-reviews.js';

const input=z.object({operation_confirmation:z.enum(['legacy','conversa','painel']).optional(),
  stock_operations_enabled:z.boolean().optional(),catalog_operations_enabled:z.boolean().optional(),
  pickup_operations_enabled:z.boolean().optional(), retail_operations_enabled:z.boolean().optional(), route_operations_enabled:z.boolean().optional(),
  pickup_completion_enabled:z.boolean().optional(), purchase_receipt_enabled:z.boolean().optional(),
}).strict().refine(value=>Object.keys(value).length>0);
export function registerOperationPermissions(app:FastifyInstance,origin:string){
  app.put('/admin/api/dot/connections/:id/operation-permissions',{preHandler:dotHumanOwner},async(req,reply)=>{
    if(req.headers.origin!==origin)return reply.code(403).send({error:'csrf_rejected'});
    const params=z.object({id:z.string().uuid()}).safeParse(req.params),body=input.safeParse(req.body);
    if(!params.success||!body.success)return reply.code(400).send({error:'invalid_request'});
    try{return await transact(async db=>{
      const person=getAdminContext(req).personId!,grant=await lockGrant(db,person,params.data.id);
      const next={operation_confirmation:grant.operation_confirmation??'legacy',stock_operations_enabled:!!grant.stock_operations_enabled,
        catalog_operations_enabled:!!grant.catalog_operations_enabled,pickup_operations_enabled:!!grant.pickup_operations_enabled,retail_operations_enabled:!!grant.retail_operations_enabled,
        route_operations_enabled:!!grant.route_operations_enabled,pickup_completion_enabled:!!grant.pickup_completion_enabled,
        purchase_receipt_enabled:!!grant.purchase_receipt_enabled,...body.data};
      await db.query(`UPDATE network.dot_oauth_grants SET operation_confirmation=$3,stock_operations_enabled=$4,catalog_operations_enabled=$5,
        pickup_operations_enabled=$6,retail_operations_enabled=$7,route_operations_enabled=$8,pickup_completion_enabled=$9,
        purchase_receipt_enabled=$10 WHERE environment=$1 AND id=$2`,[env.FAREJADOR_ENV,params.data.id,next.operation_confirmation,
        next.stock_operations_enabled,next.catalog_operations_enabled,next.pickup_operations_enabled,next.retail_operations_enabled,
        next.route_operations_enabled,next.pickup_completion_enabled,next.purchase_receipt_enabled]);
      // Trocar o canal ou revogar uma permissão invalida aprovações ainda não executadas.
      if(next.operation_confirmation!==grant.operation_confirmation || (grant.stock_operations_enabled&&!next.stock_operations_enabled)
        || (grant.catalog_operations_enabled&&!next.catalog_operations_enabled))
        await db.query(`UPDATE network.dot_operation_reviews SET expires_at=LEAST(expires_at,clock_timestamp())
          WHERE environment=$1 AND grant_id=$2 AND executed_at IS NULL`,[env.FAREJADOR_ENV,params.data.id]);
      else if (grant.pickup_operations_enabled && !next.pickup_operations_enabled)
        await db.query(`UPDATE network.dot_operation_reviews SET expires_at=LEAST(expires_at,clock_timestamp())
          WHERE environment=$1 AND grant_id=$2 AND permission_domain='pickup' AND executed_at IS NULL`,[env.FAREJADOR_ENV,params.data.id]);
      for (const domain of ['retail','route'] as const) {
        const field = (domain + '_operations_enabled') as 'retail_operations_enabled' | 'route_operations_enabled';
        if (grant[field] && !next[field]) await db.query(`UPDATE network.dot_operation_reviews SET expires_at=LEAST(expires_at,clock_timestamp())
          WHERE environment=$1 AND grant_id=$2 AND (permission_domain=$3 OR tool_name='registrar_venda_e_rota_matriz') AND executed_at IS NULL`,[env.FAREJADOR_ENV,params.data.id,domain]);
      }
      const revokedVoiceDomains = (['pickup_completion', 'purchase_receipt'] as const)
        .filter(domain => grant[`${domain}_enabled`] && !next[`${domain}_enabled`]);
      if (revokedVoiceDomains.length) await db.query(`UPDATE network.dot_operation_reviews
        SET expires_at=LEAST(expires_at,clock_timestamp()) WHERE environment=$1 AND grant_id=$2
        AND permission_domain=ANY($3::text[]) AND executed_at IS NULL`,[env.FAREJADOR_ENV,params.data.id,revokedVoiceDomains]);
      await db.query(`INSERT INTO audit.events(environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
        VALUES($1,'dot_permissions','network.dot_oauth_grants',$2,'permissions_changed',$3,$4)`,
      [env.FAREJADOR_ENV,params.data.id,'Dono · '+person,next]);
      return next;
    });}catch(error){
      const code=error instanceof Error?error.message:'';
      return reply.code(code==='dot_grant_unavailable'?404:503).send({error:'permissao_indisponivel'});
    }
  });
}
