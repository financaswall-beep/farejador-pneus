import { env } from '../../shared/config/env.js';
import { commentsConfig } from '../../social-comments/config.js';
import { META_BUSINESS_ACCOUNTS } from '../../shared/meta-business-accounts.js';
import { PublisherError } from './model.js';

export function publisherConfig() {
  const graph = commentsConfig();
  const storageReady = Boolean(env.SUPABASE_STORAGE_URL && env.SUPABASE_STORAGE_SERVICE_KEY);
  const metaReady = Boolean(graph.token && graph.scopeValid);
  const enabled = env.MARKETING_PUBLISHER_ENABLED;
  const sending = enabled && storageReady && metaReady && env.MARKETING_PUBLISHER_SEND_ENABLED && env.FAREJADOR_ENV === 'prod';
  return { enabled, sending, storage_ready: storageReady, meta_ready: metaReady,
    ai_ready: Boolean(env.OPENAI_API_KEY), max_file_bytes: env.MARKETING_MEDIA_MAX_MB*1024*1024,
    library_limit_bytes: env.MARKETING_LIBRARY_MAX_MB*1024*1024, timezone: 'America/Sao_Paulo',
    accounts: Object.entries(META_BUSINESS_ACCOUNTS).map(([platform,a]) => ({platform,...a})),
  };
}
export function requirePublisher(): void {
  if (!publisherConfig().enabled) throw new PublisherError('publisher_disabled',503);
}
export function requireSending(): void {
  requirePublisher();
  if (!publisherConfig().sending) throw new PublisherError('publisher_send_disabled',503);
}
