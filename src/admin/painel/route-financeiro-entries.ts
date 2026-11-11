import type {FastifyInstance,FastifyReply} from 'fastify';
import {z} from 'zod';
import {requireAdminOwner} from '../auth.js';
import {env} from '../../shared/config/env.js';
import {operatorLabel} from './route-helpers.js';
import {manualEntrySchema,reverseManualEntrySchema} from './manual-finance-entry-schema.js';
import {createManualFinanceEntry,reverseManualFinanceEntry} from './manual-finance-entry.js';

const enabled=()=>env.MATRIZ_CENTRAL_LEDGER&&env.MATRIZ_CENTRAL_LEDGER_READ;
export async function registerFinanceEntryRoutes(app:FastifyInstance){
  app.post('/admin/api/matriz/financeiro/entries',{preHandler:requireAdminOwner},async(request,reply)=>{
    reply.header('Cache-Control','private, no-store');
    if(!enabled())return reply.code(409).send({error:'central_ledger_read_disabled'});
    const body=manualEntrySchema.safeParse(request.body);
    if(!body.success)return reply.code(400).send({error:'invalid_entry',fields:body.error.flatten().fieldErrors});
    try{return reply.code(201).send(await createManualFinanceEntry(body.data,operatorLabel(request)));}
    catch(error){return writeError(error,reply);}
  });
  app.post('/admin/api/matriz/financeiro/entries/:id/reverse',{preHandler:requireAdminOwner},async(request,reply)=>{
    reply.header('Cache-Control','private, no-store');
    if(!enabled())return reply.code(409).send({error:'central_ledger_read_disabled'});
    const body=reverseManualEntrySchema.safeParse(request.body),params=z.object({id:z.string().uuid()}).safeParse(request.params);
    if(!body.success||!params.success)return reply.code(400).send({error:'invalid_entry'});
    try{return await reverseManualFinanceEntry(params.data.id,body.data,operatorLabel(request));}
    catch(error){return writeError(error,reply);}
  });
}
function writeError(error:unknown,reply:FastifyReply){
  const code=error instanceof Error?error.message:'';
  if(code==='manual_entry_not_found_or_date_invalid')return reply.code(400).send({error:code});
  if(['matriz_ledger_idempotency_conflict','matriz_ledger_transaction_already_reversed'].includes(code))
    return reply.code(409).send({error:code});
  return reply.code(503).send({error:'manual_entry_unavailable'});
}
