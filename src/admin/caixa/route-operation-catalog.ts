import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CaixaAuth } from './queries.js';
import { logger } from '../../shared/logger.js';
import { tireVehicleTypeSchema } from '../../shared/tire-vehicle-type.js';
import { getMatrizOperationCatalog } from './operation-catalog.js';
import { createCatalogProduct, createCatalogProductFromStock } from '../painel/queries-catalogo-create.js';
import { setCatalogPrice } from '../painel/queries-catalogo.js';
import { updateCatalogTireSpec } from '../painel/queries-catalogo-spec.js';
import { getCatalogCompatibility, getCatalogMeasureApplications, searchCatalogVehicleModels,
  addCatalogCompatibility, removeCatalogCompatibility } from '../painel/queries-catalogo-compatibilidade.js';
import { createProductBody, productParams, tireSpecBody, priceBody, vehicleSearchQuery,
  compatibilityBody, compatibilityDeleteParams, compatibilityDeleteBody } from '../painel/route-catalogo-schemas.js';

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const base = '/api/caixa/operacao/catalogo';
const actor = (request: FastifyRequest) => {
  const auth = (request as FastifyRequest & { caixa: CaixaAuth }).caixa;
  return `Caixa: ${auth.displayName} (${auth.username})`.slice(0, 120);
};
async function respond(reply: FastifyReply, action: () => Promise<unknown>, status = 200) {
  reply.header('Cache-Control', 'no-store');
  try { return reply.status(status).send(await action()); } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const statusCode = code.startsWith('catalog_')
      ? code.endsWith('_not_found') ? 404
        : /already_exists|duplicate|ambiguous|conflict/.test(code) ? 409 : 400 : 500;
    if (statusCode === 500) logger.error({ err: error }, 'operation catalog failed');
    return reply.status(statusCode).send({ error: statusCode === 500 ? 'internal_server_error' : code });
  }
}

export function registerCaixaOperationCatalogRoutes(
  fastify: FastifyInstance, guards: Guard[], requireOwner: Guard,
) {
  const read = { preHandler: guards }, write = { preHandler: [...guards, requireOwner] };
  fastify.get(base, read, async (_request, reply) => respond(reply, () => getMatrizOperationCatalog()));
  fastify.post(base + '/products', write, async (request, reply) => {
    const parsed = createProductBody.strict().safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_catalog_product' });
    const b = parsed.data;
    // No modo estoque, o web define o preço após o cadastro. Evita ignorar um preço recebido.
    if (b.creation_mode === 'stock' && b.price_amount != null) {
      return reply.status(400).send({ error: 'catalog_stock_price_after_creation' });
    }
    return respond(reply, () => (b.creation_mode === 'manual' ? createCatalogProduct : createCatalogProductFromStock)({
      measure: b.measure, brand: b.brand, tireCondition: b.tire_condition,
      productCode: b.product_code, productName: b.product_name, vehicleType: b.vehicle_type,
      treadPattern: b.tread_pattern, loadIndex: b.load_index, speedRating: b.speed_rating,
      position: b.position, priceAmount: b.price_amount, priceReason: b.price_reason,
      actorLabel: actor(request),
    }), 201);
  });
  fastify.post(base + '/:product_id/spec', write, async (request, reply) => {
    const p = productParams.safeParse(request.params), b = tireSpecBody.strict().safeParse(request.body);
    if (!p.success || !b.success) return reply.status(400).send({ error: 'invalid_catalog_spec' });
    return respond(reply, () => updateCatalogTireSpec({ productId: p.data.product_id,
      vehicleType: b.data.vehicle_type, treadPattern: b.data.tread_pattern, loadIndex: b.data.load_index,
      speedRating: b.data.speed_rating, position: b.data.position, reason: b.data.reason, actorLabel: actor(request) }));
  });
  fastify.post(base + '/:product_id/price', write, async (request, reply) => {
    const p = productParams.safeParse(request.params), b = priceBody.strict().safeParse(request.body);
    if (!p.success || !b.success) return reply.status(400).send({ error: 'invalid_catalog_price' });
    return respond(reply, () => setCatalogPrice({ productId: p.data.product_id,
      priceAmount: b.data.price_amount, reason: b.data.reason, actorLabel: actor(request) }));
  });
  fastify.get(base + '/vehicle-models', read, async (request, reply) => {
    const parsed = vehicleSearchQuery.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_vehicle_search' });
    return respond(reply, async () => ({ rows: await searchCatalogVehicleModels(parsed.data.q,
      undefined, undefined, parsed.data.vehicle_type) }));
  });
  fastify.get(base + '/measure-applications', read, async (request, reply) => {
    const parsed = z.object({ measure: z.string().trim().min(1).max(60),
      vehicle_type: tireVehicleTypeSchema.optional() }).safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_measure' });
    return respond(reply, () => getCatalogMeasureApplications(parsed.data.measure, undefined,
      undefined, parsed.data.vehicle_type));
  });
  fastify.get(base + '/:product_id/compatibility', read, async (request, reply) => {
    const p = productParams.safeParse(request.params);
    if (!p.success) return reply.status(400).send({ error: 'invalid_product_id' });
    return respond(reply, () => getCatalogCompatibility(p.data.product_id));
  });
  fastify.post(base + '/:product_id/compatibility', write, async (request, reply) => {
    const p = productParams.safeParse(request.params), b = compatibilityBody.safeParse(request.body);
    if (!p.success || !b.success) return reply.status(400).send({ error: 'invalid_catalog_compatibility' });
    return respond(reply, () => addCatalogCompatibility({ productId: p.data.product_id,
      vehicleModelId: b.data.vehicle_model_id, position: b.data.position, isOem: b.data.is_oem,
      source: b.data.source, confidenceLevel: b.data.confidence_level, yearStart: b.data.year_start,
      yearEnd: b.data.year_end, reason: b.data.reason, actorLabel: actor(request) }), 201);
  });
  fastify.delete(base + '/:product_id/compatibility/:vehicle_model_id/:position', write, async (request, reply) => {
    const p = compatibilityDeleteParams.safeParse(request.params), b = compatibilityDeleteBody.strict().safeParse(request.body);
    if (!p.success || !b.success) return reply.status(400).send({ error: 'invalid_catalog_compatibility' });
    return respond(reply, () => removeCatalogCompatibility({ productId: p.data.product_id,
      vehicleModelId: p.data.vehicle_model_id, position: p.data.position,
      reason: b.data.reason, actorLabel: actor(request) }));
  });
}
