import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAdminContext, requireAdminAuth, requireAdminOwner } from '../auth.js';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { resolveIntegrityOperation } from './stage5-integrity.js';
import { mapWriteError } from './route-helpers.js';
import { resolveIntegrityOperationSchema } from './route-schemas.js';
import {
  runMatrizStage3LedgerBackfill,
} from './matriz-ledger-stage3-reconciliation.js';
import { getMatrizStage3LedgerReconciliation } from './matriz-ledger-stage3-report.js';
import {
  getMatrizStage4LedgerReconciliation, runMatrizStage4LedgerBackfill,
} from './matriz-ledger-stage4-reconciliation.js';
import {
  getMatrizStage5LedgerReconciliation, runMatrizStage5LedgerBackfill,
} from './matriz-ledger-stage5-reconciliation.js';
import {
  getMatrizLedgerIntegrationHealth, runMatrizLedgerIntegrationBackfill,
} from './matriz-ledger-integration-health.js';
import { getMatrizLedgerCompetenceGate } from './matriz-ledger-competence-gate.js';

const stage3BackfillSchema = z.object({
  limit: z.number().int().min(1).max(5_000).optional(),
});
const competenceGateSchema = z.object({
  competences: z.string().trim().min(1).transform((value) =>
    value.split(',').map((item) => item.trim()).filter(Boolean),
  ).refine((values) => values.length >= 2 && values.length <= 24
    && values.every((value) => /^\d{4}-(0[1-9]|1[0-2])-01$/.test(value)), {
    message: 'two_competences_required',
  }),
});

/** Recupera o desfecho de uma criacao depois de reload/resposta perdida.
 * Nao aceita dominios arbitrarios: a borda expoe somente formularios "novos". */
export async function registerPainelIntegrity(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/integrity/matriz-ledger', {
    preHandler: requireAdminOwner,
  }, async (_request, reply) => reply.status(200).send(
    await getMatrizLedgerIntegrationHealth(),
  ));

  fastify.get('/admin/api/integrity/matriz-ledger/competences', {
    preHandler: requireAdminOwner,
  }, async (request, reply) => {
    const parsed = competenceGateSchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.issues[0]?.message ?? 'invalid_query',
      });
    }
    return reply.status(200).send(
      await getMatrizLedgerCompetenceGate(parsed.data.competences),
    );
  });

  fastify.post('/admin/api/integrity/matriz-ledger/backfill', {
    preHandler: requireAdminOwner,
  }, async (request, reply) => {
    const parsed = stage3BackfillSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      return reply.status(200).send(await runMatrizLedgerIntegrationBackfill({
        limit: parsed.data.limit,
      }));
    } catch (error) {
      const mapped = mapWriteError(error);
      logger.error({ err: error, status: mapped.status }, 'matriz ledger backfill failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.get('/admin/api/integrity/matriz-ledger/stage5', {
    preHandler: requireAdminOwner,
  }, async (_request, reply) => reply.status(200).send(
    await getMatrizStage5LedgerReconciliation(),
  ));

  fastify.post('/admin/api/integrity/matriz-ledger/stage5/backfill', {
    preHandler: requireAdminOwner,
  }, async (request, reply) => {
    const parsed = stage3BackfillSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      return reply.status(200).send(await runMatrizStage5LedgerBackfill({
        limit: parsed.data.limit,
      }));
    } catch (error) {
      const mapped = mapWriteError(error);
      logger.error({ err: error, status: mapped.status }, 'matriz stage5 backfill failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.get('/admin/api/integrity/matriz-ledger/stage4', {
    preHandler: requireAdminOwner,
  }, async (_request, reply) => reply.status(200).send(
    await getMatrizStage4LedgerReconciliation(),
  ));

  fastify.post('/admin/api/integrity/matriz-ledger/stage4/backfill', {
    preHandler: requireAdminOwner,
  }, async (request, reply) => {
    const parsed = stage3BackfillSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      return reply.status(200).send(await runMatrizStage4LedgerBackfill({
        limit: parsed.data.limit,
      }));
    } catch (error) {
      const mapped = mapWriteError(error);
      logger.error({ err: error, status: mapped.status }, 'matriz stage4 backfill failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.get('/admin/api/integrity/matriz-ledger/stage3', {
    preHandler: requireAdminOwner,
  }, async (_request, reply) => reply.status(200).send(
    await getMatrizStage3LedgerReconciliation(),
  ));

  fastify.post('/admin/api/integrity/matriz-ledger/stage3/backfill', {
    preHandler: requireAdminOwner,
  }, async (request, reply) => {
    const parsed = stage3BackfillSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      return reply.status(200).send(await runMatrizStage3LedgerBackfill({
        limit: parsed.data.limit,
      }));
    } catch (error) {
      const mapped = mapWriteError(error);
      logger.error({ err: error, status: mapped.status }, 'matriz stage3 backfill failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/integrity/resolve', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = resolveIntegrityOperationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    if (parsed.data.domain === 'partner.create' && getAdminContext(request).role !== 'owner') {
      return reply.status(403).send({ error: 'admin_owner_required' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await resolveIntegrityOperation(client, {
        environment: env.FAREJADOR_ENV,
        domain: parsed.data.domain,
        idempotencyKey: parsed.data.idempotency_key,
      });
      await client.query('COMMIT');
      return reply.status(200).send(result);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const mapped = mapWriteError(error);
      logger.error({ err: error, status: mapped.status }, 'painel integrity resolve failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    } finally {
      client.release();
    }
  });
}
