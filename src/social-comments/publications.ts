import { createHash } from 'node:crypto';
import { CommentsGraph, MetaCommentError, safePostUrl } from './graph.js';
import { ownsAccount, type CommentsConfig, type Platform } from './config.js';
import { safeMetaImageUrl } from '../marketing/meta-creatives.js';

export interface OrganicPublication {
  id: string;
  platform: Platform;
  account_id: string;
  title: string;
  caption: string;
  published_at: string;
  format: 'image' | 'video' | 'reel' | 'carousel' | 'text' | 'unknown';
  image_url: string | null;
  url: string | null;
}
type Json = Record<string, any>;
const fields = {
  facebook: 'id,message,created_time,permalink_url,full_picture,from,attachments{media_type,type,title}',
  instagram: 'id,caption,timestamp,permalink,media_type,media_product_type,media_url,thumbnail_url,owner',
};
const validId = (id: unknown): id is string => typeof id === 'string' && /^\d{1,40}(?:_\d{1,40})?$/.test(id);

/** Only deterministic presentation metadata; never copies captions into analytical facts. */
export function parsePublication(data: Json, platform: Platform, account: string): OrganicPublication | null {
  if (!validId(data.id)) return null;
  const owner = platform === 'facebook' ? data.from?.id : data.owner?.id;
  if (String(owner ?? '') !== account) return null;
  if (data.media_product_type === 'AD' || data.media_product_type === 'STORY') return null;
  const date = new Date(data.created_time ?? data.timestamp ?? '');
  if (!Number.isFinite(date.getTime())) return null;
  const caption = String(data.message ?? data.caption ?? '').slice(0, 6000).trim();
  const attachment = data.attachments?.data?.[0];
  const mediaType = String(data.media_type ?? attachment?.media_type ?? '').toUpperCase();
  const format: OrganicPublication['format'] = data.media_product_type === 'REELS' ? 'reel'
    : mediaType === 'CAROUSEL_ALBUM' || mediaType === 'ALBUM' ? 'carousel'
    : mediaType === 'VIDEO' ? 'video'
    : mediaType === 'IMAGE' || mediaType === 'PHOTO' ? 'image'
    : platform === 'facebook' && !attachment && !data.full_picture ? 'text' : 'unknown';
  const rawTitle = caption.split(/\r?\n/).find(line => line.trim()) || attachment?.title || 'Publicação sem legenda';
  return { id: data.id, platform, account_id: account, title: String(rawTitle).slice(0, 140), caption,
    published_at: date.toISOString(), format,
    image_url: safeMetaImageUrl(platform === 'facebook' ? data.full_picture
      : mediaType === 'VIDEO' ? data.thumbnail_url : data.media_url),
    url: safePostUrl(data.permalink_url ?? data.permalink) };
}

export class PublicationsGraph extends CommentsGraph {
  async publications(platform: Platform, account: string, since: string) {
    await this.assertAccount(platform, account);
    const rows = new Map<string, OrganicPublication>();
    const boundary = Date.parse(`${since}T00:00:00-03:00`);
    let after: string | undefined;
    let truncated = false;
    // Bound provider work. Report an incomplete list instead of claiming a complete total.
    for (let page = 0; page < 3; page++) {
      const data = await this.call(`${account}/${platform === 'facebook' ? 'published_posts' : 'media'}`, 'GET', {
        fields: fields[platform], limit: '50', ...(after ? { after } : {}),
        ...(platform === 'facebook' ? { since: String(Math.floor(boundary / 1000)) } : {}),
      });
      if (!Array.isArray(data.data)) throw new MetaCommentError('meta_publications_invalid_response');
      const parsed = data.data.map((row: Json) => parsePublication(row, platform, account));
      for (const row of parsed) if (row && Date.parse(row.published_at) >= boundary) rows.set(row.id, row);
      const cursor = data.paging?.cursors?.after;
      // Never follow paging.next: it may contain credentials or an arbitrary hostname.
      const hasNext = Boolean(data.paging?.next);
      const reachedBoundary = platform === 'instagram' && parsed.some((row: OrganicPublication | null) =>
        row && Date.parse(row.published_at) < boundary);
      if (!hasNext || reachedBoundary) { truncated = false; break; }
      truncated = true;
      if (typeof cursor !== 'string' || !cursor || cursor.length > 3000 || cursor === after) break;
      after = cursor;
    }
    return { rows: [...rows.values()], truncated };
  }

  async publication(platform: Platform, account: string, id: string): Promise<OrganicPublication> {
    if (!validId(id)) throw new MetaCommentError('meta_invalid_path');
    await this.assertAccount(platform, account);
    const data = await this.call(id, 'GET', { fields: fields[platform] });
    const row = parsePublication(data, platform, account);
    if (!row || row.id !== id) throw new MetaCommentError('meta_post_owner_mismatch');
    return row;
  }
}

export interface PublicationSource {
  platform: Platform;
  status: 'ready' | 'unavailable' | 'not_configured';
  error: string | null;
  truncated: boolean;
}
export interface PublicationsSnapshot {
  rows: OrganicPublication[];
  sources: PublicationSource[];
  fetched_at: string;
}
const cache = new Map<string, { expires: number; request: Promise<PublicationsSnapshot> }>();
export function clearPublicationsCache(): void { cache.clear(); }

export async function readPublications(config: CommentsConfig, environment: string, since: string,
  fetcher: typeof fetch = fetch): Promise<PublicationsSnapshot> {
  const credential = createHash('sha256').update(`${config.token ?? ''}:${config.appSecret ?? ''}`).digest('hex');
  const key = `${environment}:${config.pageId}:${config.instagramId}:${config.apiVersion}:${config.scopeValid}:${credential}:${since}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.request;
  const request = (async () => {
    const graph = new PublicationsGraph(config, fetcher);
    const results = await Promise.all((['facebook', 'instagram'] as const).map(async platform => {
      const account = platform === 'facebook' ? config.pageId : config.instagramId;
      const source: PublicationSource = { platform, status: 'ready', error: null, truncated: false };
      if (!account || !config.token) return { rows: [], source: { ...source, status: 'not_configured' as const } };
      try {
        if (!ownsAccount(config, platform, account)) throw new MetaCommentError('meta_account_not_allowed');
        const result = await graph.publications(platform, account, since);
        return { rows: result.rows, source: { ...source, truncated: result.truncated } };
      } catch (error) {
        return { rows: [], source: { ...source, status: 'unavailable' as const,
          error: error instanceof MetaCommentError ? error.code : 'meta_publications_unavailable' } };
      }
    }));
    return { rows: results.flatMap(result => result.rows), sources: results.map(result => result.source),
      fetched_at: new Date().toISOString() };
  })();
  cache.set(key, { expires: Date.now() + 60_000, request });
  while (cache.size > 8) cache.delete(cache.keys().next().value!);
  return request;
}
