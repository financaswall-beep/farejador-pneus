import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminOwner,getAdminContext } from '../auth.js';
import { listMetaIdentityReviews,setMetaIdentityDecision } from '../../marketing/meta-identity-decisions.js';
import { listGoogleConversionReviews,reviewGoogleConversion } from '../../marketing/google-conversion-review.js';

const reason=z.string().trim().min(10).max(1000);
export async function registerMarketingReviews(fastify:FastifyInstance) {
  fastify.get('/admin/api/marketing/meta/identity-reviews',{preHandler:requireAdminOwner},async(request,reply)=> {
    if(!z.object({}).strict().safeParse(request.query).success)return reply.code(400).send({error:'invalid_review_query'});
    try {return reply.header('Cache-Control','no-store').send(await listMetaIdentityReviews());}
    catch {return reply.code(503).send({error:'meta_identity_reviews_unavailable'});}
  });
  fastify.post('/admin/api/marketing/meta/ad-accounts/:account/ads/:ad/identity-decision',
    {preHandler:requireAdminOwner},async(request,reply)=>{
      const params=z.object({account:z.string().regex(/^(?:act_)?\d{1,30}$/),ad:z.string().regex(/^\d{1,30}$/)}).strict().safeParse(request.params);
      const body=z.object({scope:z.enum(['matrix','external','automatic']),reason}).strict().safeParse(request.body);
      if(!params.success||!body.success)return reply.code(400).send({error:'invalid_identity_decision'});
      try {return reply.header('Cache-Control','no-store').send(await setMetaIdentityDecision({...params.data,...body.data,
        actor:getAdminContext(request).displayName,idempotencyKey:String(request.id)}));}
      catch(error) {
        const code=error instanceof Error?error.message:'meta_identity_decision_failed';
        return reply.code(code==='meta_ad_not_found'?404:code==='meta_identity_sync_required'?409:503).send({
          error:['meta_ad_not_found','meta_identity_sync_required'].includes(code)?code:'meta_identity_decision_failed'});
      }
    });
  fastify.get('/admin/api/marketing/google-ads/conversion-reviews',{preHandler:requireAdminOwner},async(request,reply)=> {
    if(!z.object({}).strict().safeParse(request.query).success)return reply.code(400).send({error:'invalid_review_query'});
    try {return reply.header('Cache-Control','no-store').send(await listGoogleConversionReviews());}
    catch {return reply.code(503).send({error:'google_conversion_reviews_unavailable'});}
  });
  fastify.post('/admin/api/marketing/google-ads/conversions/:id/review',{preHandler:requireAdminOwner},async(request,reply)=>{
    const params=z.object({id:z.string().uuid()}).strict().safeParse(request.params);
    const body=z.object({action:z.enum(['check','retry','close']),reason}).strict().safeParse(request.body);
    if(!params.success||!body.success)return reply.code(400).send({error:'invalid_conversion_review'});
    try {return reply.header('Cache-Control','no-store').send(await reviewGoogleConversion({...params.data,...body.data,
      actor:getAdminContext(request).displayName,idempotencyKey:String(request.id)}));}
    catch(error) {
      const code=error instanceof Error?error.message:'google_review_unavailable';
      const known=['google_conversion_not_found','google_conversion_not_reviewable','google_review_not_configured',
        'google_request_missing','google_sale_not_eligible','google_conversions_disabled','google_retry_not_proven_safe'];
      return reply.code(code==='google_conversion_not_found'?404:known.includes(code)?409:503)
        .send({error:known.includes(code)?code:'google_review_unavailable'});
    }
  });
}
