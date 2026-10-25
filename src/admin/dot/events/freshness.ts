import { env } from '../../../shared/config/env.js';
import type { DotSettings } from './settings.js';

/** Delay allowance is added to the integration's actual schedule, not substituted for it. */
export function freshnessMs(platform:'meta'|'google',settings:DotSettings) {
 return (platform==='meta'?env.MARKETING_SYNC_INTERVAL_MS:3600000)+settings.system_stale_minutes*60000;
}
