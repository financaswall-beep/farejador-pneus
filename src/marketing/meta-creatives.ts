/** Leitura dos criativos da conta configurada. Nenhum token ou HTML da Meta sai na resposta. */
import { createHash } from 'node:crypto';
import type { MetaMarketingConfig } from '../admin/painel/marketing-meta.js';

export interface MetaCreative {
  id: string;
  creative_id: string | null;
  name: string | null;
  status: string | null;
  format: 'image' | 'video' | 'carousel' | 'mixed' | 'unknown';
  image_url: string | null;
  body: string | null;
  title: string | null;
}
type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Json : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim()
  ? value.slice(0, 3000) : null;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function safeMetaImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    const allowed = ['fbcdn.net', 'fbsbx.com', 'cdninstagram.com', 'facebook.com'];
    if (!allowed.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    if ([...url.searchParams.keys()].some((key) => /access_token|appsecret|authorization/i.test(key))) return null;
    return url.href;
  } catch { return null; }
}

export function parseMetaCreative(value: unknown, config: MetaMarketingConfig): MetaCreative | null {
  const ad = object(value);
  if (!/^\d+$/.test(String(ad.id)) || String(ad.account_id) !== config.adAccountId.replace(/^act_/, '')) return null;
  const creative = object(ad.creative);
  const story = object(creative.object_story_spec);
  const link = object(story.link_data);
  const video = object(story.video_data);
  const photo = object(story.photo_data);
  const feed = object(creative.asset_feed_spec);
  const images = list(feed.images);
  const videos = list(feed.videos);
  const carousel = list(link.child_attachments);
  const hasVideo = Boolean(creative.video_id || video.video_id || videos.length);
  const hasImage = Boolean(creative.image_url || creative.image_hash || link.picture || link.image_hash || photo.image_hash || images.length);
  const candidates = [creative.image_url, link.picture, photo.url, video.image_url,
    object(carousel[0]).picture, object(images[0]).url, creative.thumbnail_url];
  return {
    id: String(ad.id), creative_id: text(creative.id), name: text(ad.name),
    status: text(ad.effective_status),
    format: carousel.length ? 'carousel' : hasVideo && images.length ? 'mixed'
      : hasVideo ? 'video' : hasImage ? 'image' : 'unknown',
    image_url: candidates.map(safeMetaImageUrl).find(Boolean) ?? null,
    body: text(creative.body) ?? text(link.message) ?? text(video.message) ?? text(object(list(feed.bodies)[0]).text),
    title: text(creative.title) ?? text(link.name) ?? text(video.title),
  };
}

const FIELDS = 'id,account_id,name,effective_status,creative{id,name,title,body,image_hash,image_url,thumbnail_url,video_id,object_story_spec,asset_feed_spec}';
const cache = new Map<string, { expires: number; value: MetaCreative | null }>();
function cacheKey(config: MetaMarketingConfig, id: string): string {
  const credential = createHash('sha256').update(config.accessToken).digest('hex').slice(0, 16);
  return `${config.adAccountId}:${config.apiVersion}:${credential}:${id}`;
}
export function clearMetaCreativeCache(): void { cache.clear(); }

export async function getMetaCreatives(
  config: MetaMarketingConfig,
  ids: string[],
  fetcher: typeof fetch = fetch,
): Promise<{ ads: MetaCreative[]; unavailable: number }> {
  const unique = [...new Set(ids)].filter((id) => /^\d+$/.test(id));
  const now = Date.now();
  const missing = unique.filter((id) => (cache.get(cacheKey(config, id))?.expires ?? 0) <= now).slice(0, 200);
  const batches: string[][] = [];
  for (let offset = 0; offset < missing.length; offset += 50) {
    batches.push(missing.slice(offset, offset + 50));
  }
  await Promise.all(batches.map(async (batch) => {
    let payload: Json = {};
    try {
      const url = new URL(`https://graph.facebook.com/${encodeURIComponent(config.apiVersion)}/`);
      url.search = new URLSearchParams({ ids: batch.join(','), fields: FIELDS }).toString();
      const response = await fetcher(url, {
        headers: { Authorization: `Bearer ${config.accessToken}` },
        signal: AbortSignal.timeout(12000), redirect: 'error',
      });
      if (response.ok) payload = object(await response.json());
    } catch { /* Metadados indisponíveis não escondem os indicadores já sincronizados. */ }
    for (const id of batch) {
      const parsed = parseMetaCreative(payload[id], config);
      const value = parsed?.id === id ? parsed : null;
      cache.set(cacheKey(config, id), { expires: now + (value ? 900000 : 60000), value });
    }
  }));
  const ads = unique.map((id) => cache.get(cacheKey(config, id))?.value).filter((ad): ad is MetaCreative => Boolean(ad));
  while (cache.size > 1000) cache.delete(cache.keys().next().value!);
  return { ads, unavailable: ids.length - ads.length };
}

export function metaAdManagerUrl(accountId: string, adId: string): string {
  return `https://adsmanager.facebook.com/adsmanager/manage/ads?${new URLSearchParams({
    act: accountId.replace(/^act_/, ''), selected_ad_ids: adId,
  })}`;
}

/** Abre a prévia oficial em outra aba; não injeta iframe/HTML externo no painel. */
export async function getMetaCreativePreview(config: MetaMarketingConfig, adId: string): Promise<string> {
  const fallback = metaAdManagerUrl(config.adAccountId, adId);
  try {
    const url = new URL(`https://graph.facebook.com/${encodeURIComponent(config.apiVersion)}/${encodeURIComponent(adId)}/previews`);
    url.searchParams.set('ad_format', 'MOBILE_FEED_STANDARD');
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
      signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    if (!response.ok) return fallback;
    const body = text(object(list(object(await response.json()).data)[0]).body);
    const src = body?.match(/\bsrc=["']([^"']+)["']/i)?.[1]?.replace(/&amp;/g, '&');
    if (!src) return fallback;
    const target = new URL(src);
    if (target.protocol !== 'https:' || target.hostname !== 'www.facebook.com'
        || !target.pathname.startsWith('/ads/api/preview') || target.username || target.password
        || (target.port && target.port !== '443')
        || [...target.searchParams.keys()].some((key) => /access_token|appsecret|authorization/i.test(key))) return fallback;
    return target.href;
  } catch { return fallback; }
}
