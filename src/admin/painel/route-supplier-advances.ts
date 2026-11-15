import type {FastifyInstance} from 'fastify';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {pool} from '../../persistence/db.js';
import {env} from '../../shared/config/env.js';
import {requireAdminAuth,requireAdminOwner} from '../auth.js';
import {operatorLabel} from './route-helpers.js';
import {advanceCommandSchema} from './supplier-advance-schema.js';
import {MatchingAdvance,runSupplierAdvance} from './supplier-advances.js';
import {supplierFinanceDetail,supplierFinanceSummary} from './supplier-finance-read.js';
import {reencodePhoto,PhotoRejectedError} from '../../parceiro/photo-upload.js';

const path='/admin/api/matriz/financeiro/fornecedores';
const id=z.object({id:z.string().uuid()});
const enabled=()=>env.MATRIZ_CENTRAL_LEDGER && env.MATRIZ_CENTRAL_LEDGER_READ;
export function registerSupplierAdvances(app:FastifyInstance){
  app.get(path,{preHandler:requireAdminAuth},async(_req,reply)=>{
    if(!enabled())return reply.code(409).send({error:'Livro financeiro indisponível.'});
    return {rows:await supplierFinanceSummary(),writable:env.WHOLESALE_FINANCE};
  });
  app.get(path+'/:id',{preHandler:requireAdminAuth},async(req,reply)=>{
    if(!enabled())return reply.code(409).send({error:'Livro financeiro indisponível.'});
    const params=id.safeParse(req.params);
    if(!params.success)return reply.code(400).send({error:'Fornecedor inválido.'});
    try{return await supplierFinanceDetail(params.data.id);}
    catch(error){if(error instanceof Error && error.message==='Fornecedor não encontrado.')return reply.code(404).send({error:error.message});throw error;}
  });
  app.post(path+'/movimentos',{preHandler:requireAdminOwner},async(req,reply)=>{
    const body=advanceCommandSchema.safeParse(req.body);
    if(!body.success)return reply.code(400).send({error:'Confira fornecedor, valor, data, origem e motivo.'});
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const row=await runSupplierAdvance(client,body.data,operatorLabel(req));
      await client.query('COMMIT');
      return reply.code(201).send(row);
    }catch(error){
      await client.query('ROLLBACK');
      if(error instanceof MatchingAdvance)return reply.code(409).send({error:error.message,matches:error.matches});
      if(error instanceof Error && !('severity' in error))return reply.code(409).send({error:error.message});
      throw error;
    }finally{client.release();}
  });
  app.post(path+'/adiantamentos/:id/comprovantes',{preHandler:requireAdminOwner,bodyLimit:2_900_000},async(req,reply)=>{
    const params=id.safeParse(req.params),body=z.object({image:z.string().min(4).max(2796204)}).safeParse(req.body);
    if(!enabled()||!params.success||!body.success)return reply.code(400).send({error:'Comprovante inválido.'});
    const bytes=Buffer.from(body.data.image,'base64');
    if(bytes.length>2097152)return reply.code(413).send({error:'Imagem acima de 2 MB.'});
    try{
      const image=(await reencodePhoto(bytes)).bytes,digest=createHash('sha256').update(image).digest('hex');
      const origin=await pool.query("SELECT id FROM finance.matriz_ledger_transactions WHERE environment=$1 AND id=$2 AND source_type='finance.supplier_advance.issue'",[env.FAREJADOR_ENV,params.data.id]);
      if(!origin.rowCount)return reply.code(404).send({error:'Adiantamento não encontrado.'});
      await pool.query(`INSERT INTO finance.supplier_advance_receipts(environment,advance_id,digest,image,created_by)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[env.FAREJADOR_ENV,params.data.id,digest,image,operatorLabel(req)]);
      return {digest};
    }catch(error){if(error instanceof PhotoRejectedError)return reply.code(400).send({error:'Use JPEG, PNG ou WebP.'});throw error;}
  });
  app.get(path+'/adiantamentos/:id/comprovantes/:digest',{preHandler:requireAdminAuth},async(req,reply)=>{
    const params=id.extend({digest:z.string().regex(/^[a-f0-9]{64}$/)}).safeParse(req.params);
    if(!enabled()||!params.success)return reply.code(400).send({error:'Comprovante inválido.'});
    const result=await pool.query('SELECT image FROM finance.supplier_advance_receipts WHERE environment=$1 AND advance_id=$2 AND digest=$3',[env.FAREJADOR_ENV,params.data.id,params.data.digest]);
    if(!result.rows[0])return reply.code(404).send({error:'Comprovante não encontrado.'});
    return reply.header('Cache-Control','private, no-store').type('image/jpeg').send(result.rows[0].image);
  });
}
