import type { OrganicPublication } from '../../social-comments/publications.js';
import type { CommentsConfig, Platform } from '../../social-comments/config.js';

export interface PostReference { platform: Platform; account_id: string; post_id: string }
export interface ResultDelivery extends PostReference {
  format: string; status: string; post_url: string | null; error_code: string | null;
  published_at: string | null; views: number | null; observed_at: string | null;
}
export interface ResultPublication extends OrganicPublication {
  key: string; publisher_id: string | null; status: string; deliveries: ResultDelivery[];
  views: number | null; views_complete: boolean; version?: number;
}
export interface CentralResult {
  id: string; title: string; caption: string; status: string; scheduled_at: string;
  created_at: string; thumbnail_path: string | null; image_url?: string | null; version: number;
  deliveries: ResultDelivery[];
}
export function activeOrganicPlatforms(config: CommentsConfig): Platform[] {
  if (!config.token || config.scopeValid === false) return [];
  return (['instagram', 'facebook'] as const).filter(platform =>
    Boolean(platform === 'instagram' ? config.instagramId : config.pageId));
}
export function deliveryViews(deliveries: ResultDelivery[]) {
  const published = deliveries.filter(d => d.status === 'published');
  const known = published.filter(d => d.views !== null && Number.isSafeInteger(d.views) && d.views >= 0);
  return { views: known.length ? known.reduce((sum, d) => sum + d.views!, 0) : null,
    views_complete: published.length > 0 && known.length === published.length };
}
export function mergeOrganicResults(posts: OrganicPublication[], central: CentralResult[], active: Platform[]) {
  const key = (p: PostReference) => `${p.platform}:${p.account_id}:${p.post_id}`;
  const lookup = new Map(posts.map(p => [key({ ...p, post_id: p.id }), p]));
  const consumed = new Set<string>();
  const rows: ResultPublication[] = [];
  // Vínculo somente pelos IDs confirmados de entrega; títulos iguais nunca agrupam posts.
  for (const post of central) {
    const deliveries = post.deliveries.filter(d => active.includes(d.platform));
    if (!deliveries.length) continue;
    const linked = deliveries.filter(d => d.status === 'published' && d.post_id).map(d => lookup.get(key(d))).filter(Boolean);
    for (const d of deliveries) if (d.status === 'published' && d.post_id) consumed.add(key(d));
    const first = linked[0];
    const published = deliveries.map(d => d.published_at).filter((d): d is string => Boolean(d));
    rows.push({ id: post.id, key: `publisher:${post.id}`, publisher_id: post.id,
      platform: deliveries[0]!.platform, account_id: deliveries[0]!.account_id,
      title: post.title, caption: post.caption, status: post.status, deliveries, version: post.version,
      published_at: published.sort()[0] ?? post.scheduled_at ?? post.created_at,
      format: first?.format ?? (deliveries[0]!.format === 'reel' ? 'reel' : 'unknown'),
      image_url: first?.image_url ?? post.image_url ?? null, url: first?.url ?? deliveries[0]!.post_url,
      ...deliveryViews(deliveries) });
  }
  for (const post of posts) {
    const reference = { platform: post.platform, account_id: post.account_id, post_id: post.id };
    if (!active.includes(post.platform) || consumed.has(key(reference))) continue;
    const deliveries: ResultDelivery[] = [{ ...reference, format: post.format, status: 'published',
      post_url: post.url, error_code: null, published_at: post.published_at, views: null, observed_at: null }];
    rows.push({ ...post, key: `${post.platform}:${post.id}`, publisher_id: null,
      status: 'published', deliveries, ...deliveryViews(deliveries) });
  }
  return rows.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || a.key.localeCompare(b.key));
}
