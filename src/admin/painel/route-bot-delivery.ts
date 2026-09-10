import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminOwner } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { deliverySettingsSchema } from '../../atendente-v2/matriz-delivery-settings.js';
import { getBotDeliveryConfig,saveBotDeliveryConfig } from './bot-delivery-config.js';
import { deliveryProducts,geocodeDeliveryAddress,simulateBotDelivery } from './bot-delivery-simulation.js';
import { operatorLabel } from './route-helpers.js';

const saveSchema=z.object({settings:deliverySettingsSchema,expected_version:z.number().int().min(0)}).strict();
const addressSchema=z.object({address:z.string().trim().min(5).max(350)}).strict();
const simulateSchema=z.object({address:addressSchema.shape.address,settings:deliverySettingsSchema,
  items:z.array(z.object({product_id:z.string().uuid(),quantity:z.number().int().positive().max(50)}).strict()).min(1).max(8)}).strict();
const searchSchema=z.object({q:z.string().trim().min(2).max(100)}).strict();
function mapError(error:unknown){
  const message=error instanceof Error?error.message:'';
  if(message==='delivery_settings_conflict') return {code:409,error:message};
  if(message==='delivery_address_not_found'||message==='delivery_product_not_found') return {code:422,error:message};
  logger.error({err:error},'bot delivery configuration failed');
  return {code:500,error:'delivery_unavailable'};
}
export async function registerBotDeliveryRoutes(app:FastifyInstance){
  const auth={preHandler:requireAdminOwner};
  app.get('/admin/api/bot/entrega',auth,async(_request,reply)=>{
    reply.header('Cache-Control','private, no-store');
    try{return await getBotDeliveryConfig();}catch(error){const m=mapError(error);return reply.code(m.code).send({error:m.error});}
  });
  app.put('/admin/api/bot/entrega',auth,async(request,reply)=>{
    const body=saveSchema.safeParse(request.body);
    if(!body.success)return reply.code(400).send({error:'invalid_delivery_settings',issues:body.error.flatten()});
    try{return await saveBotDeliveryConfig(body.data.settings,body.data.expected_version,operatorLabel(request));}
    catch(error){const m=mapError(error);return reply.code(m.code).send({error:m.error});}
  });
  app.get('/admin/api/bot/entrega/produtos',auth,async(request,reply)=>{
    const query=searchSchema.safeParse(request.query);
    if(!query.success)return reply.code(400).send({error:'invalid_query'});
    try{return {products:await deliveryProducts(query.data.q)};}catch(error){const m=mapError(error);return reply.code(m.code).send({error:m.error});}
  });
  app.post('/admin/api/bot/entrega/localizar',auth,async(request,reply)=>{
    const body=addressSchema.safeParse(request.body);
    if(!body.success)return reply.code(400).send({error:'invalid_address'});
    try{return await geocodeDeliveryAddress(body.data.address);}catch(error){const m=mapError(error);return reply.code(m.code).send({error:m.error});}
  });
  app.post('/admin/api/bot/entrega/simular',auth,async(request,reply)=>{
    const body=simulateSchema.safeParse(request.body);
    if(!body.success)return reply.code(400).send({error:'invalid_simulation',issues:body.error.flatten()});
    reply.header('Cache-Control','private, no-store');
    try{return await simulateBotDelivery(body.data);}catch(error){const m=mapError(error);return reply.code(m.code).send({error:m.error});}
  });
}
