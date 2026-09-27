import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { pollOrganicEvents } from './inbound.js';

export function startOrganicWorker(): () => void {
  if (!env.ORGANIC_ATTRIBUTION_ENABLED) return () => undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const run = async () => {
    if (stopped) return;
    try { await pollOrganicEvents(pool); }
    catch { logger.warn('Organic reconciliation deferred'); }
    if (!stopped) timer = setTimeout(() => void run(), 5_000);
  };
  void run();
  return () => { stopped = true; clearTimeout(timer); };
}
