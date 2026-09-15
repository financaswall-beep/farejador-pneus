import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAdminContext,requireAdminAuth,requireAdminOwner } from '../auth.js';
import { mapWriteError,operatorLabel } from './route-helpers.js';
import { listLotSales,listSaleLots,lotSalesReady } from './queries-lot-sales.js';
import { lotSaleSchema } from './lot-sale-schema.js';
import { registerLotSale } from './register-lot-sale.js';
import { cancelWholesaleSale } from './queries-atacado-cancelar.js';
import { env } from '../../shared/config/env.js';
export async function registerLotSaleRoutes(app: FastifyInstance) {
  app.get('/admin/api/wholesale/lot-sales', {preHandler:requireAdminAuth}, async (request,reply)=>{
    const query=z.object({page:z.coerce.number().int().min(1).max(100000).default(1)}).safeParse(request.query);
    if (!query.success) return reply.status(400).send({error:'invalid_query'});
    if (!await lotSalesReady()) return {ready:false,rows:[],lots:[],total:0,finance_enabled:false};
    const [history,lots]=await Promise.all([listLotSales(query.data.page),listSaleLots()]);
    return {ready:true,...history,lots,finance_enabled:env.WHOLESALE_FINANCE&&env.MATRIZ_CENTRAL_LEDGER};
  });
  app.post('/admin/api/wholesale/lot-sales',{preHandler:requireAdminOwner},async(request,reply)=>{
    const body=lotSaleSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({error:body.error.issues[0]?.message||'invalid_body'});
    if (!await lotSalesReady()) return reply.status(503).send({error:'lot_sales_migration_required'});
    try { return reply.status(201).send(await registerLotSale(body.data,operatorLabel(request),getAdminContext(request).collaboratorId)); }
    catch(error) {
      const code=error instanceof Error?error.message:'';
      if (code.startsWith('lot_sale_')||code==='sold_at_future'||code==='buyer_not_found') return reply.status(409).send({error:code});
      const mapped=mapWriteError(error);return reply.status(mapped.status).send({error:mapped.error});
    }
  });
  app.post('/admin/api/wholesale/lot-sales/:id/cancel',{preHandler:requireAdminOwner},async(request,reply)=>{
    const params=z.object({id:z.string().uuid()}).safeParse(request.params);
    const body=z.object({reason:z.string().trim().min(5).max(300),idempotency_key:z.string().uuid()}).safeParse(request.body);
    if (!params.success||!body.success) return reply.status(400).send({error:'invalid_body'});
    if (!await lotSalesReady()) return reply.status(503).send({error:'lot_sales_migration_required'});
    try { return await cancelWholesaleSale({order_id:params.data.id,...body.data,cancelled_by:operatorLabel(request)}); }
    catch(error) {const mapped=mapWriteError(error);return reply.status(mapped.status).send({error:mapped.error});}
  });
}
