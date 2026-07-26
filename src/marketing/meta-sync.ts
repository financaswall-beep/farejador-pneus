import type { Pool } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import {
  canonicalConversationAction,
  clearMetaMarketingCache,
  fetchMetaInsightRows,
  getMetaMarketingSnapshot,
  marketingDateWindow,
  summarizeMetaRows,
  type MarketingPeriod,
  type MetaInsightLevel,
  type MetaInsightRow,
  type MetaMarketingConfig,
  type MetaMarketingSnapshot,
} from '../admin/painel/marketing-meta.js';

type SyncTrigger = 'startup' | 'scheduled' | 'manual';

export interface MetaSyncResult {
  run_id: string;
  rows_upserted: number;
  since: string;
  until: string;
  levels: MetaInsightLevel[];
}

function isoDateInSaoPaulo(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days))
    .toISOString().slice(0, 10);
}

function metaConfig(): MetaMarketingConfig {
  if (!env.MARKETING_META_ENABLED || !env.META_ADS_ACCOUNT_ID || !env.META_ADS_ACCESS_TOKEN) {
    throw new Error('marketing_meta_not_configured');
  }
  return {
    accessToken: env.META_ADS_ACCESS_TOKEN,
    adAccountId: env.META_ADS_ACCOUNT_ID,
    apiVersion: env.META_GRAPH_API_VERSION,
  };
}

function insightValues(row: MetaInsightRow, level: MetaInsightLevel) {
  const entityId = String(level === 'ad' ? row.ad_id ?? '' : row.campaign_id ?? '');
  const campaignId = String(row.campaign_id ?? '');
  if (!entityId || !campaignId || !row.date_start) return null;
  const canonical = canonicalConversationAction(row.actions);
  return {
    entityId,
    campaignId,
    entityName: String(level === 'ad' ? row.ad_name ?? entityId : row.campaign_name ?? entityId),
    campaignName: String(row.campaign_name ?? campaignId),
    adsetId: row.adset_id ? String(row.adset_id) : null,
    adsetName: row.adset_name ? String(row.adset_name) : null,
    metricDate: String(row.date_start),
    currency: String(row.account_currency ?? 'BRL'),
    spend: Number(row.spend ?? 0),
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    reach: row.reach == null ? null : Number(row.reach),
    conversations: Math.round(canonical.value),
    actionType: canonical.actionType,
    actions: Array.isArray(row.actions) ? row.actions : [],
  };
}

export async function syncMetaInsights(options: {
  triggerType?: SyncTrigger;
  now?: Date;
  lookbackDays?: number;
  fetcher?: typeof fetch;
  dbPool?: Pool;
  config?: MetaMarketingConfig;
} = {}): Promise<MetaSyncResult> {
  const now = options.now ?? new Date();
  const until = isoDateInSaoPaulo(now);
  const since = shiftDate(until, -((options.lookbackDays ?? 60) - 1));
  const levels: MetaInsightLevel[] = ['campaign', 'ad'];
  const dbPool = options.dbPool ?? defaultPool;
  const config = options.config ?? metaConfig();
  const run = await dbPool.query<{ id: string }>(
    `INSERT INTO marketing.meta_sync_runs
       (environment,trigger_type,window_since,window_until,levels)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [env.FAREJADOR_ENV, options.triggerType ?? 'manual', since, until, levels],
  );
  const runId = run.rows[0]?.id;
  if (!runId) throw new Error('marketing_sync_run_not_created');

  try {
    const fetched = await Promise.all(levels.map(async (level) => ({
      level,
      rows: await fetchMetaInsightRows(config, since, until, level, options.fetcher ?? fetch),
    })));
    const client = await dbPool.connect();
    let rowsUpserted = 0;
    try {
      await client.query('BEGIN');
      for (const group of fetched) {
        for (const row of group.rows) {
          const value = insightValues(row, group.level);
          if (!value) continue;
          await client.query(
            `INSERT INTO marketing.meta_insights_daily (
               environment,sync_run_id,ad_account_id,api_version,account_currency,
               entity_level,entity_id,entity_name,campaign_id,campaign_name,adset_id,
               adset_name,metric_date,spend,impressions,clicks,reach,conversations,
               conversation_action_type,actions_raw,collected_at
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now()
             )
             ON CONFLICT (environment,ad_account_id,entity_level,entity_id,metric_date)
             DO UPDATE SET sync_run_id=EXCLUDED.sync_run_id,api_version=EXCLUDED.api_version,
               account_currency=EXCLUDED.account_currency,entity_name=EXCLUDED.entity_name,
               campaign_id=EXCLUDED.campaign_id,campaign_name=EXCLUDED.campaign_name,
               adset_id=EXCLUDED.adset_id,adset_name=EXCLUDED.adset_name,
               spend=EXCLUDED.spend,impressions=EXCLUDED.impressions,clicks=EXCLUDED.clicks,
               reach=EXCLUDED.reach,conversations=EXCLUDED.conversations,
               conversation_action_type=EXCLUDED.conversation_action_type,
               actions_raw=EXCLUDED.actions_raw,collected_at=now()`,
            [
              env.FAREJADOR_ENV, runId, config.adAccountId, config.apiVersion,
              value.currency, group.level, value.entityId, value.entityName,
              value.campaignId, value.campaignName, value.adsetId, value.adsetName,
              value.metricDate, value.spend, value.impressions, value.clicks,
              value.reach, value.conversations, value.actionType, JSON.stringify(value.actions),
            ],
          );
          rowsUpserted += 1;
        }
      }
      await client.query(
        `UPDATE marketing.meta_sync_runs
            SET status='succeeded',rows_upserted=$2,finished_at=now()
          WHERE environment=$1 AND id=$3`,
        [env.FAREJADOR_ENV, rowsUpserted, runId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    clearMetaMarketingCache();
    return { run_id: runId, rows_upserted: rowsUpserted, since, until, levels };
  } catch (error) {
    const summary = error instanceof Error ? error.message.slice(0, 300) : 'unknown';
    await dbPool.query(
      `UPDATE marketing.meta_sync_runs
          SET status='failed',error_code='meta_sync_failed',error_summary=$2,finished_at=now()
        WHERE environment=$1 AND id=$3`,
      [env.FAREJADOR_ENV, summary, runId],
    ).catch(() => undefined);
    throw error;
  }
}

export async function getPersistedMetaSnapshot(
  config: MetaMarketingConfig,
  period: MarketingPeriod,
  options: { now?: Date; dbPool?: Pool } = {},
): Promise<MetaMarketingSnapshot | null> {
  const now = options.now ?? new Date();
  const window = marketingDateWindow(period, now);
  try {
    const result = await (options.dbPool ?? defaultPool).query<MetaInsightRow & { collected_at: string }>(
      `SELECT campaign_id,campaign_name,metric_date::text AS date_start,spend::text,
              impressions::text,clicks::text,reach::text,actions_raw AS actions,
              account_currency,collected_at::text
         FROM marketing.meta_insights_daily
        WHERE environment=$1 AND ad_account_id=$2 AND entity_level='campaign'
          AND metric_date BETWEEN $3::date AND $4::date
        ORDER BY metric_date,entity_id`,
      [env.FAREJADOR_ENV, config.adAccountId, window.previousSince, window.until],
    );
    if (result.rows.length === 0) return null;
    const fetchedAt = result.rows.reduce(
      (latest, row) => String(row.collected_at) > latest ? String(row.collected_at) : latest,
      '',
    );
    return {
      current: summarizeMetaRows(result.rows, window.since, window.until),
      previous: summarizeMetaRows(result.rows, window.previousSince, window.previousUntil),
      fetched_at: fetchedAt || now.toISOString(),
    };
  } catch {
    return null;
  }
}

export async function getPersistedOrLiveMetaSnapshot(
  config: MetaMarketingConfig,
  period: MarketingPeriod,
  options: { now?: Date; fetcher?: typeof fetch; cacheMs?: number; dbPool?: Pool } = {},
): Promise<MetaMarketingSnapshot> {
  const persisted = await getPersistedMetaSnapshot(config, period, options);
  return persisted ?? getMetaMarketingSnapshot(config, period, options);
}
