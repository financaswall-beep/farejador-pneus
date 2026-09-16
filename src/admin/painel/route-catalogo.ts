import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth, requireAdminOwner } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { getCatalogOverview, getCatalogPriceHistory, setCatalogPrice } from './queries-catalogo.js';
import {
  addCatalogCompatibility,
  createCatalogFitmentDiscovery,
  getCatalogFitmentDiscoveries,
  getCatalogCompatibility,
  getCatalogMeasureApplications,
  removeCatalogCompatibility,
  reviewCatalogFitmentDiscovery,
  searchCatalogVehicleModels,
} from './queries-catalogo-compatibilidade.js';
import { createCatalogProduct, createCatalogProductFromStock } from './queries-catalogo-create.js';
import { updateCatalogTireSpec } from './queries-catalogo-spec.js';
import { operatorLabel } from './route-helpers.js';
import { tireVehicleTypeSchema, tireVehicleFilterSchema } from '../../shared/tire-vehicle-type.js';
import { getCatalogVehicleInventory } from './catalog-vehicle-inventory.js';

import {
  productParams,
  priceBody,
  createProductBody,
  tireSpecBody,
  vehicleSearchQuery,
  compatibilityBody,
  compatibilityDeleteParams,
  compatibilityDeleteBody,
  discoveryBody,
  discoveryParams,
  discoveryReviewBody
} from './route-catalogo-schemas.js';

export async function registerPainelCatalogo(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/catalog', { preHandler: requireAdminAuth }, async (request, reply) => {
    const query = z.object({ vehicle_type: tireVehicleFilterSchema.default('all') }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: 'invalid_vehicle_type' });
    return reply.status(200).send(await getCatalogOverview(undefined, undefined, query.data.vehicle_type));
  });

  fastify.get('/admin/api/catalog/vehicle-inventory', { preHandler: requireAdminOwner }, async (_request, reply) => {
    return reply.send(await getCatalogVehicleInventory());
  });

  fastify.post('/admin/api/catalog/products', { preHandler: requireAdminOwner }, async (request, reply) => {
    const body = createProductBody.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'invalid_catalog_product' });
    try {
      const create = body.data.creation_mode === 'manual'
        ? createCatalogProduct : createCatalogProductFromStock;
      const product = await create({
        measure: body.data.measure,
        brand: body.data.brand,
        tireCondition: body.data.tire_condition,
        vehicleType: body.data.vehicle_type,
        productCode: body.data.product_code,
        productName: body.data.product_name,
        actorLabel: operatorLabel(request),
        priceAmount: body.data.price_amount,
        priceReason: body.data.price_reason,
        treadPattern: body.data.tread_pattern,
        loadIndex: body.data.load_index,
        speedRating: body.data.speed_rating,
        position: body.data.position,
      });
      return reply.status(201).send(product);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal_server_error';
      const status = message === 'catalog_stock_variant_not_found' ? 404
        : ['catalog_stock_variant_ambiguous', 'catalog_variant_already_exists',
           'catalog_product_code_duplicate'].includes(message) ? 409
          : message.startsWith('catalog_') ? 400 : 500;
      if (status === 500) logger.error({ error }, 'painel catalog product create failed');
      return reply.status(status).send({ error: status === 500 ? 'internal_server_error' : message });
    }
  });

  fastify.get('/admin/api/catalog/measure-applications', { preHandler: requireAdminAuth }, async (request, reply) => {
    const query = z.object({ measure: z.string().trim().min(1).max(60),
      vehicle_type: tireVehicleTypeSchema.optional() }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: 'invalid_measure' });
    return reply.send(await getCatalogMeasureApplications(query.data.measure, undefined, undefined, query.data.vehicle_type));
  });

  fastify.post('/admin/api/catalog/:product_id/spec', { preHandler: requireAdminOwner }, async (request, reply) => {
    const params = productParams.safeParse(request.params);
    const body = tireSpecBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: 'invalid_catalog_spec' });
    }
    try {
      return reply.status(200).send(await updateCatalogTireSpec({
        productId: params.data.product_id,
        vehicleType: body.data.vehicle_type,
        treadPattern: body.data.tread_pattern,
        loadIndex: body.data.load_index,
        speedRating: body.data.speed_rating,
        position: body.data.position,
        reason: body.data.reason,
        actorLabel: operatorLabel(request),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal_server_error';
      const status = message === 'catalog_product_not_found' ? 404
        : message === 'catalog_stock_vehicle_type_conflict' ? 409
          : message.startsWith('catalog_spec_') || message === 'catalog_vehicle_type_invalid' ? 400 : 500;
      if (status === 500) logger.error({ error }, 'painel catalog tire spec update failed');
      return reply.status(status).send({ error: status === 500 ? 'internal_server_error' : message });
    }
  });

  fastify.get('/admin/api/catalog/vehicle-models', { preHandler: requireAdminAuth }, async (request, reply) => {
    const query = vehicleSearchQuery.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: 'invalid_vehicle_search' });
    return reply.status(200).send({ rows: await searchCatalogVehicleModels(query.data.q, undefined, undefined, query.data.vehicle_type) });
  });

  fastify.get('/admin/api/catalog/:product_id/history', { preHandler: requireAdminAuth }, async (request, reply) => {
    const params = productParams.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_product_id' });
    return reply.status(200).send({ rows: await getCatalogPriceHistory(params.data.product_id) });
  });

  fastify.get('/admin/api/catalog/:product_id/compatibility', { preHandler: requireAdminAuth }, async (request, reply) => {
    const params = productParams.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_product_id' });
    try {
      return reply.status(200).send(await getCatalogCompatibility(params.data.product_id));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal_server_error';
      const status = message === 'catalog_product_not_found' ? 404 : 500;
      if (status === 500) logger.error({ error }, 'painel catalog compatibility failed');
      return reply.status(status).send({ error: status === 500 ? 'internal_server_error' : message });
    }
  });

  fastify.post('/admin/api/catalog/:product_id/compatibility', { preHandler: requireAdminOwner }, async (request, reply) => {
    const params = productParams.safeParse(request.params);
    const body = compatibilityBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: 'invalid_catalog_compatibility' });
    }
    try {
      return reply.status(201).send(await addCatalogCompatibility({
        productId: params.data.product_id,
        vehicleModelId: body.data.vehicle_model_id,
        position: body.data.position,
        isOem: body.data.is_oem,
        source: body.data.source,
        confidenceLevel: body.data.confidence_level,
        yearStart: body.data.year_start,
        yearEnd: body.data.year_end,
        reason: body.data.reason,
        actorLabel: operatorLabel(request),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal_server_error';
      const status = ['catalog_product_not_found', 'catalog_vehicle_model_not_found'].includes(message)
        ? 404 : message.startsWith('catalog_') ? 400 : 500;
      if (status === 500) logger.error({ error }, 'painel catalog compatibility create failed');
      return reply.status(status).send({ error: status === 500 ? 'internal_server_error' : message });
    }
  });

  fastify.delete('/admin/api/catalog/:product_id/compatibility/:vehicle_model_id/:position', { preHandler: requireAdminOwner }, async (request, reply) => {
    const params = compatibilityDeleteParams.safeParse(request.params);
    const body = compatibilityDeleteBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: 'invalid_catalog_compatibility' });
    }
    try {
      return reply.status(200).send(await removeCatalogCompatibility({
        productId: params.data.product_id,
        vehicleModelId: params.data.vehicle_model_id,
        position: params.data.position,
        reason: body.data.reason,
        actorLabel: operatorLabel(request),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal_server_error';
      const status = message === 'catalog_product_not_found' ? 404
        : message.startsWith('catalog_') ? 400 : 500;
      if (status === 500) logger.error({ error }, 'painel catalog compatibility delete failed');
      return reply.status(status).send({ error: status === 500 ? 'internal_server_error' : message });
    }
  });

  fastify.get('/admin/api/catalog/:product_id/fitment-discoveries', { preHandler: requireAdminAuth }, async (request, reply) => {
    const params = productParams.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_product_id' });
    try {
      return reply.status(200).send({
        rows: await getCatalogFitmentDiscoveries(params.data.product_id),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal_server_error';
      const status = message === 'catalog_product_not_found' ? 404 : 500;
      if (status === 500) logger.error({ error }, 'painel catalog discovery list failed');
      return reply.status(status).send({ error: status === 500 ? 'internal_server_error' : message });
    }
  });

  fastify.post('/admin/api/catalog/:product_id/fitment-discoveries', { preHandler: requireAdminOwner }, async (request, reply) => {
    const params = productParams.safeParse(request.params);
    const body = discoveryBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: 'invalid_catalog_discovery' });
    }
    try {
      return reply.status(201).send(await createCatalogFitmentDiscovery({
        productId: params.data.product_id,
        vehicleModelId: body.data.vehicle_model_id,
        position: body.data.position,
        sourceUrl: body.data.source_url,
        sourceTitle: body.data.source_title,
        evidenceSummary: body.data.evidence_summary,
        suggestedIsOem: body.data.suggested_is_oem,
        confidenceLevel: body.data.confidence_level,
        yearStart: body.data.year_start,
        yearEnd: body.data.year_end,
        actorLabel: operatorLabel(request),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal_server_error';
      const status = ['catalog_product_not_found', 'catalog_vehicle_model_not_found'].includes(message)
        ? 404 : message === 'catalog_discovery_already_pending' ? 409
          : message.startsWith('catalog_') ? 400 : 500;
      if (status === 500) logger.error({ error }, 'painel catalog discovery create failed');
      return reply.status(status).send({ error: status === 500 ? 'internal_server_error' : message });
    }
  });

  fastify.post('/admin/api/catalog/:product_id/fitment-discoveries/:discovery_id/review', { preHandler: requireAdminOwner }, async (request, reply) => {
    const params = discoveryParams.safeParse(request.params);
    const body = discoveryReviewBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: 'invalid_catalog_discovery_review' });
    }
    try {
      return reply.status(200).send(await reviewCatalogFitmentDiscovery({
        productId: params.data.product_id,
        discoveryId: params.data.discovery_id,
        decision: body.data.decision,
        reason: body.data.reason,
        actorLabel: operatorLabel(request),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal_server_error';
      const status = ['catalog_product_not_found', 'catalog_discovery_not_found'].includes(message)
        ? 404 : ['catalog_discovery_already_reviewed', 'catalog_discovery_measure_mismatch'].includes(message)
          ? 409 : message.startsWith('catalog_') ? 400 : 500;
      if (status === 500) logger.error({ error }, 'painel catalog discovery review failed');
      return reply.status(status).send({ error: status === 500 ? 'internal_server_error' : message });
    }
  });

  fastify.post('/admin/api/catalog/:product_id/price', { preHandler: requireAdminOwner }, async (request, reply) => {
    const params = productParams.safeParse(request.params);
    const body = priceBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_catalog_price' });
    try {
      return reply.status(200).send(await setCatalogPrice({
        productId: params.data.product_id,
        priceAmount: body.data.price_amount,
        reason: body.data.reason,
        actorLabel: operatorLabel(request),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal_server_error';
      const status = message === 'catalog_product_not_found' ? 404
        : message.startsWith('catalog_price_') ? 400 : 500;
      logger.error({ error, status }, 'painel catalog price update failed');
      return reply.status(status).send({ error: status === 500 ? 'internal_server_error' : message });
    }
  });
}
