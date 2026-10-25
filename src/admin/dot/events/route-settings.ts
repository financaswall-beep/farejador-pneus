import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAdminContext } from '../../auth.js';
import { dotHumanOwner } from '../route-oauth.js';
import { pool } from '../../../persistence/db.js';
import { env } from '../../../shared/config/env.js';
import { dotEventsState } from './availability.js';
import { readSettings,saveSettings,settingsSchema,ruleLabels } from './settings.js';
import { eventDefinitions } from './model.js';
import { signalSourceStatus } from './signals.js';
import { activeSubscriptionsSql,subscriptionParams } from './subscriptions.js';
import { dotConfig } from '../config.js';

export async function registerDotAlertSettings(app:FastifyInstance) {
 app.get('/admin/api/dot/alerts',{preHandler:dotHumanOwner},async(request,reply)=>{
  reply.header('Cache-Control','no-store');
  try {
   const person=getAdminContext(request).personId!;
   const [config,subscriptions,external]=await Promise.all([readSettings(),dotConfig()?pool.query(`SELECT id,event_name,arguments,expires_at,last_delivery_at
    FROM (${activeSubscriptionsSql} AND s.person_id=$4) active ORDER BY event_name,id`,[...subscriptionParams(),person]):Promise.resolve({rows:[]}),pool.query(
    'SELECT status,consecutive_failures,last_checked_at FROM ops.dot_external_health WHERE environment=$1',[env.FAREJADOR_ENV])]);
   return {...config,runtime:dotEventsState(),subscriptions:subscriptions.rows,external_monitor:external.rows[0]??null,
    source_checks:signalSourceStatus(),timezone:'America/Sao_Paulo',
    rules:eventDefinitions.map(event=>({name:event.name,label:ruleLabels[event.name],description:event.description}))};
  }catch{return reply.code(503).send({error:'dot_settings_unavailable'});}
 });
 app.put('/admin/api/dot/alerts',{preHandler:dotHumanOwner,bodyLimit:20000},async(request,reply)=>{
  reply.header('Cache-Control','no-store');
  const input=z.object({version:z.number().int().min(0),settings:settingsSchema}).strict().safeParse(request.body);
  if(!input.success)return reply.code(400).send({error:'invalid_dot_settings'});
  try{return await saveSettings(input.data.settings,input.data.version,getAdminContext(request).personId!);}
  catch(error){const reason=error instanceof Error?error.message:'';
   return reply.code(reason==='dot_settings_conflict'?409:reason==='owner_required'?403:503)
    .send({error:reason==='dot_settings_conflict'?reason:reason==='owner_required'?reason:'dot_settings_unavailable'});}
 });
}
