import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { MetaCommentError } from '../../social-comments/graph.js';
import { PublisherStorage } from './storage.js';
import { PublisherGraph, type PublishingGraph } from './graph.js';
import { claimDelivery, setDelivery, type Task } from './queue.js';
import { publisherConfig } from './config.js';
import { cleanupMedia } from './cleanup.js';
import { PublisherError, type Environment } from './model.js';
import { validateDestinationMedia } from './media-validation.js';

const MAX_SAFE_RETRIES = 5;
function expired(task: Task, verification = false): boolean {
  const start = verification ? task.public_started_at ?? task.started_at : task.started_at;
  return start !== null && Date.now() - new Date(start).getTime() > 2 * 3_600_000;
}
function temporaryFailure(error: unknown): boolean {
  if (error instanceof PublisherError) return error.status >= 500;
  if (!(error instanceof MetaCommentError)) return true;
  return /^(meta_(connection|response)_unknown|publisher_upload_unknown)$/.test(error.code)
    || /^meta_http_(408|429|5\d\d)_/.test(error.code)
    || /^meta_http_\d+_code_(1|2|4|17|32|613)$/.test(error.code);
}

/** Repetições automáticas só antes da chamada pública ou nas consultas de confirmação. */
export async function publishTick(db: Pool, environment: Environment, graph: PublishingGraph,
  storage = new PublisherStorage()): Promise<boolean> {
  const task = await claimDelivery(db, environment);
  if (!task) return false;
  let publicWrite = false;
  try {
    if (task.status === 'publishing') {
      await setDelivery(db, environment, task, 'uncertain', { error: 'publisher_confirmation_required' });
      return true;
    }
    if (task.status === 'preparing') {
      if (expired(task)) {
        await setDelivery(db, environment, task, 'failed', { error: 'publisher_processing_timeout' });
        return true;
      }
      validateDestinationMedia(task, [task]);
      await storage.assertPrivateBucket();
      const url = await storage.signedUrl(task.publish_path ?? task.original_path, 3600);
      const container = await graph.prepare(task, url);
      await setDelivery(db, environment, task, 'processing', { container });
      return true;
    }
    if (task.status === 'processing') {
      if (expired(task)) {
        await setDelivery(db, environment, task, 'failed', { error: 'publisher_processing_timeout' });
        return true;
      }
      if (!await graph.ready(task)) {
        await setDelivery(db, environment, task, 'processing');
        return true;
      }
      // Segurança e permissões são revalidadas antes de cruzar a fronteira pública.
      validateDestinationMedia(task, [task]);
      await storage.assertPrivateBucket();
      await graph.assertPermissions(task);
      if (!await setDelivery(db, environment, task, 'publishing')) return true;
      publicWrite = true;
      const provider = await graph.publish(task);
      await setDelivery(db, environment, task, 'verifying', { provider });
      return true;
    }
    if (task.status === 'verifying') {
      const result = await graph.verify(task);
      const timedOut = expired(task, true);
      await setDelivery(db, environment, task,
        result.confirmed ? 'published' : timedOut ? 'uncertain' : 'verifying', {
          url: result.url,
          ...(!result.confirmed && timedOut ? { error: 'publisher_confirmation_required' } : {}),
        });
    }
  } catch (error) {
    const providerError = error instanceof MetaCommentError ? error : null;
    const safe = providerError?.code
      ?? (error instanceof PublisherError ? error.code : 'publisher_service_unavailable');
    if (task.status === 'verifying') {
      await setDelivery(db, environment, task, expired(task, true) ? 'uncertain' : 'verifying', {
        error: safe, delaySeconds: 30,
      });
    } else {
      const uncertain = Boolean(providerError?.uncertain && (publicWrite || safe === 'publisher_already_published'))
        || publicWrite && !providerError;
      const retries = task.retry_attempts ?? 0;
      if (!uncertain && !publicWrite && temporaryFailure(error)
        && retries < MAX_SAFE_RETRIES && !expired(task)) {
        await setDelivery(db, environment, task, task.status, {
          error: safe, retryAttempts: retries + 1,
          delaySeconds: Math.min(300, 15 * 2 ** retries),
        });
      } else {
        await setDelivery(db, environment, task, uncertain ? 'uncertain' : 'failed', { error: safe });
      }
    }
  }
  return true;
}

export function startPublisherWorker(): () => void {
  if (!publisherConfig().enabled || !publisherConfig().storage_ready) return () => undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let count = 0;
  const run = async () => {
    if (stopped) return;
    try {
      if (publisherConfig().sending) await publishTick(pool, env.FAREJADOR_ENV, new PublisherGraph());
      if (++count % 12 === 0) await cleanupMedia(pool, env.FAREJADOR_ENV);
    } catch {
      logger.warn('Publisher operation deferred');
    }
    if (!stopped) timer = setTimeout(() => void run(), 5000);
  };
  void run();
  return () => { stopped = true; clearTimeout(timer); };
}
