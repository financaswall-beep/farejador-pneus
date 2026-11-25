import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { applicationMeasureKey } from '../../shared/vehicle-tire-applications.js';
import { requireAdminOwner } from '../auth.js';
import { createCatalogCarModel, createCarMeasureApplications } from './catalog-car-registration.js';
import { productParams } from './route-catalogo-schemas.js';
import { operatorLabel } from './route-helpers.js';

const name = z.string().trim().min(1).max(100).transform(value => value.replace(/\s+/g, ' '));
const year = z.number().int().min(1900).max(2100);
const validPeriod = (value: {year_start: number; year_end: number}) => value.year_start <= value.year_end;
export const carModelBody = z.object({
  vehicle_type: z.literal('car'), make: name, model: name, variant: name.nullish(),
  year_start: year, year_end: year,
}).strict().refine(validPeriod);
export const carReferenceBody = z.object({
  vehicle_model_id: z.string().uuid(),
  tire_size: z.string().trim().min(1).max(60).transform(value => value.toUpperCase().replace(/\s+/g, ''))
    .refine(value => Boolean(applicationMeasureKey(value))),
  year_start: year, year_end: year, position: z.enum(['front','rear','both']),
  index_spec: z.string().trim().max(30).nullish(),
  source_url: z.preprocess(value => typeof value === 'string' && !value.trim() ? null : value,
    z.string().trim().max(2048).url().refine(value => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    }).nullable().default(null)),
}).strict().refine(validPeriod);

const errorStatus = new Map([
  ['catalog_product_not_found', 404], ['catalog_vehicle_model_not_found', 404],
  ['catalog_vehicle_model_conflict', 409], ['catalog_application_conflict', 409],
  ['catalog_car_required', 400], ['catalog_application_measure_mismatch', 400],
  ['catalog_application_years_mismatch', 400],
]);

async function save<T extends {created: number | boolean}>(reply: FastifyReply, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return reply.code(result.created ? 201 : 200).send(result);
  } catch (error) {
    await client.query('ROLLBACK');
    const message = error instanceof Error ? error.message : '';
    const status = errorStatus.get(message);
    if (status) return reply.code(status).send({error: message});
    reply.log.error({ error }, 'Falha ao cadastrar carro ou referência de medida');
    return reply.code(500).send({error: 'internal_server_error'});
  } finally {
    client.release();
  }
}

export function registerCatalogCarRoutes(fastify: FastifyInstance) {
  fastify.post('/admin/api/catalog/vehicle-models', {preHandler: requireAdminOwner}, async (request, reply) => {
    const parsed = carModelBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:'invalid_car_model'});
    return save(reply, client => createCatalogCarModel(client, env.FAREJADOR_ENV, parsed.data, operatorLabel(request)));
  });
  fastify.post('/admin/api/catalog/:product_id/measure-applications', {preHandler: requireAdminOwner}, async (request, reply) => {
    const params = productParams.safeParse(request.params);
    const parsed = carReferenceBody.safeParse(request.body);
    if (!parsed.success || !params.success) return reply.code(400).send({error:'invalid_car_reference'});
    return save(reply, client => createCarMeasureApplications(client, env.FAREJADOR_ENV,
      params.data.product_id, parsed.data, operatorLabel(request)));
  });
}
