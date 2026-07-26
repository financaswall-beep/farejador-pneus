import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { reconcileMarketingAttributions } from './attribution.js';
import { enqueueCapiPurchases } from './capi.js';
import { syncMetaInsights } from './meta-sync.js';

const ATTRIBUTION_INTERVAL_MS = 5 * 60_000;

async function runAttributionCycle(): Promise<void> {
  if (!env.MARKETING_ATTRIBUTION) return;
  try {
    const result = await reconcileMarketingAttributions();
    const enqueued = await enqueueCapiPurchases();
    logger.info({ ...result, capi_enqueued: enqueued }, 'marketing attribution cycle completed');
  } catch (error) {
    logger.warn({ err: error }, 'marketing attribution cycle deferred');
  }
}

async function runSync(triggerType: 'startup' | 'scheduled', lookbackDays: number): Promise<void> {
  if (!env.MARKETING_SYNC_ENABLED) return;
  try {
    const result = await syncMetaInsights({ triggerType, lookbackDays });
    logger.info(result, 'marketing Meta sync completed');
  } catch (error) {
    logger.warn({ err: error }, 'marketing Meta sync deferred');
  }
}

export function startMarketingScheduler(): () => void {
  if (!env.MARKETING_SYNC_ENABLED && !env.MARKETING_ATTRIBUTION) return () => undefined;
  let stopped = false;
  let syncTimer: NodeJS.Timeout | null = null;
  let attributionTimer: NodeJS.Timeout | null = null;

  const syncLoop = async (startup: boolean): Promise<void> => {
    if (stopped) return;
    await runSync(startup ? 'startup' : 'scheduled', startup ? 60 : 7);
    if (!stopped) {
      syncTimer = setTimeout(() => void syncLoop(false), env.MARKETING_SYNC_INTERVAL_MS);
    }
  };
  const attributionLoop = async (): Promise<void> => {
    if (stopped) return;
    await runAttributionCycle();
    if (!stopped) {
      attributionTimer = setTimeout(() => void attributionLoop(), ATTRIBUTION_INTERVAL_MS);
    }
  };

  void syncLoop(true);
  void attributionLoop();
  logger.info('marketing scheduler started');
  return () => {
    stopped = true;
    if (syncTimer) clearTimeout(syncTimer);
    if (attributionTimer) clearTimeout(attributionTimer);
  };
}
