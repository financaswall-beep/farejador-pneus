import { CommentsGraph, MetaCommentError, safePostUrl } from '../../social-comments/graph.js';
import { commentsConfig, type CommentsConfig } from '../../social-comments/config.js';
import { accountId, type Destination } from './model.js';

export interface Delivery extends Destination {
  account_id: string;
  container_id: string | null;
  provider_id: string | null;
  media_kind: string;
}
export interface PublicationProof {
  outcome: 'published' | 'not_published' | 'unknown';
  provider_id?: string;
  url?: string | null;
  evidence: string;
}
export interface PublishingGraph {
  assertPermissions(d: Delivery): Promise<void>;
  prepare(d: Delivery, url: string): Promise<string>;
  ready(d: Delivery): Promise<boolean>;
  publish(d: Delivery): Promise<string>;
  verify(d: Delivery): Promise<{ confirmed: boolean; url: string | null }>;
  reconcile(d: Delivery): Promise<PublicationProof>;
}
function providerId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9_]+$/.test(value)) {
    throw new MetaCommentError('publisher_meta_ack_unknown', true);
  }
  return value;
}
const PUBLISH_SCOPES = {
  facebook: ['pages_read_engagement', 'pages_manage_posts'],
  instagram: ['pages_read_engagement', 'instagram_basic', 'instagram_content_publish'],
};

/** Cliente Graph nas duas contas fixadas; respostas e tokens não aparecem em erros. */
export class PublisherGraph extends CommentsGraph implements PublishingGraph {
  constructor(private publisherGraphConfig: CommentsConfig = commentsConfig(),
    private publisherFetch: typeof fetch = fetch) {
    super(publisherGraphConfig, publisherFetch);
  }
  private check(d: Delivery): void {
    if (d.account_id !== accountId(d.platform)) throw new MetaCommentError('meta_account_not_allowed');
  }
  private async permissions(platform: Destination['platform']) {
    const config = this.publisherGraphConfig;
    if (!config.appId || !config.appSecret || !config.token) {
      return { permissions_checked: false, missing_permissions: PUBLISH_SCOPES[platform] };
    }
    const debug = await this.call('debug_token', 'GET', { input_token: config.token },
      `${config.appId}|${config.appSecret}`);
    const data = debug.data;
    if (data?.is_valid !== true || String(data.app_id) !== config.appId) {
      throw new MetaCommentError('publisher_token_invalid');
    }
    const now = Date.now() / 1000;
    if (['expires_at', 'data_access_expires_at'].some(field =>
      typeof data[field] === 'number' && data[field] > 0 && data[field] <= now)) {
      throw new MetaCommentError('publisher_token_expired');
    }
    const scopes = Array.isArray(data.scopes) ? data.scopes : [];
    const granular = Array.isArray(data.granular_scopes) ? data.granular_scopes : [];
    const missing = PUBLISH_SCOPES[platform].filter(scope => {
      if (!scopes.includes(scope)) return true;
      const grant = granular.find((item: any) => item.scope === scope);
      const target = scope.startsWith('instagram_') ? config.instagramId : config.pageId;
      return grant && Array.isArray(grant.target_ids)
        && !grant.target_ids.some((id: unknown) => String(id) === target);
    });
    return { permissions_checked: true, missing_permissions: missing };
  }
  async assertPermissions(d: Delivery): Promise<void> {
    this.check(d);
    await this.assertAccount(d.platform, d.account_id);
    const report = await this.permissions(d.platform);
    if (!report.permissions_checked) throw new MetaCommentError('publisher_permissions_unchecked');
    if (report.missing_permissions.length) throw new MetaCommentError('publisher_permissions_missing');
  }
  async prepare(d: Delivery, url: string): Promise<string> {
    await this.assertPermissions(d);
    if (d.platform === 'instagram') {
      const params: Record<string, string> = d.media_kind === 'photo' ? { image_url: url } : { video_url: url };
      if (d.format === 'story') params.media_type = 'STORIES';
      else {
        params.caption = d.caption ?? '';
        if (d.format === 'reel') { params.media_type = 'REELS'; params.share_to_feed = 'true'; }
      }
      return providerId((await this.call(`${d.account_id}/media`, 'POST', params)).id);
    }
    if (d.media_kind === 'photo') {
      return providerId((await this.call(`${d.account_id}/photos`, 'POST', { url, published: 'false' })).id);
    }
    const edge = d.format === 'story' ? 'video_stories' : 'video_reels';
    const container = providerId((await this.call(`${d.account_id}/${edge}`, 'POST', { upload_phase: 'start' })).video_id);
    // Ignorar upload_url externo: host e versão são definidos pelo servidor.
    let response: Response;
    try {
      response = await this.publisherFetch(
        `https://rupload.facebook.com/video-upload/${this.publisherGraphConfig.apiVersion}/${container}`, {
          method: 'POST', redirect: 'error',
          headers: { Authorization: `OAuth ${this.publisherGraphConfig.token}`, file_url: url },
          signal: AbortSignal.timeout(30_000),
        });
    } catch { throw new MetaCommentError('publisher_upload_unknown'); }
    let data: { success?: boolean };
    try { data = await response.json() as { success?: boolean }; }
    catch { throw new MetaCommentError('publisher_upload_unknown'); }
    if (response.status === 429 || response.status >= 500) throw new MetaCommentError('publisher_upload_unknown');
    if (!response.ok || data.success !== true) throw new MetaCommentError('publisher_upload_rejected');
    return container;
  }
  async ready(d: Delivery): Promise<boolean> {
    this.check(d);
    if (!d.container_id) throw new MetaCommentError('publisher_container_missing');
    if (d.platform === 'instagram') {
      const result = await this.call(d.container_id, 'GET', { fields: 'status_code' });
      if (['ERROR', 'EXPIRED'].includes(result.status_code)) throw new MetaCommentError('publisher_processing_failed');
      if (result.status_code === 'PUBLISHED') throw new MetaCommentError('publisher_already_published', true);
      return result.status_code === 'FINISHED';
    }
    if (d.media_kind === 'photo') return true;
    const result = await this.call(d.container_id, 'GET', { fields: 'status' });
    if (result.status?.video_status === 'error') throw new MetaCommentError('publisher_processing_failed');
    return result.status?.uploading_phase?.status === 'complete';
  }
  async publish(d: Delivery): Promise<string> {
    this.check(d);
    if (!d.container_id) throw new MetaCommentError('publisher_container_missing');
    if (d.platform === 'instagram') {
      return providerId((await this.call(`${d.account_id}/media_publish`, 'POST', { creation_id: d.container_id })).id);
    }
    if (d.media_kind === 'photo') {
      const edge = d.format === 'story' ? 'photo_stories' : 'feed';
      const params: Record<string, string> = d.format === 'story' ? { photo_id: d.container_id } : {
        message: d.caption ?? '', attached_media: JSON.stringify([{ media_fbid: d.container_id }]), published: 'true',
      };
      const result = await this.call(`${d.account_id}/${edge}`, 'POST', params);
      if (d.format === 'story' && result.success === true) {
        return typeof result.post_id === 'string' ? providerId(result.post_id) : d.container_id;
      }
      return providerId(result.post_id ?? result.id);
    }
    const edge = d.format === 'story' ? 'video_stories' : 'video_reels';
    const result = await this.call(`${d.account_id}/${edge}`, 'POST', {
      upload_phase: 'finish', video_id: d.container_id, video_state: 'PUBLISHED',
      ...(d.format === 'reel' ? { description: d.caption ?? '' } : {}),
    });
    if (result.success !== true) throw new MetaCommentError('publisher_meta_ack_unknown', true);
    return d.container_id;
  }
  private async story(d: Delivery) {
    const result = await this.call(`${d.account_id}/stories`, 'GET',
      { fields: 'id,media_id,post_id,status,url', limit: '100' });
    return Array.isArray(result.data) ? result.data.find((item: Record<string, unknown>) =>
      [item.id, item.media_id, item.post_id].some(value =>
        value != null && [d.provider_id, d.container_id].filter(Boolean).includes(String(value)))) : undefined;
  }
  async verify(d: Delivery): Promise<{ confirmed: boolean; url: string | null }> {
    this.check(d);
    if (!d.provider_id) throw new MetaCommentError('publisher_provider_missing');
    if (d.platform === 'instagram') {
      const result = await this.call(d.provider_id, 'GET',
        { fields: d.format === 'story' ? 'id,timestamp' : 'id,timestamp,permalink' });
      return { confirmed: result.id === d.provider_id && typeof result.timestamp === 'string', url: safePostUrl(result.permalink) };
    }
    if (d.format === 'story') {
      const result = await this.story(d);
      return { confirmed: result?.status === 'PUBLISHED', url: safePostUrl(result?.url) };
    }
    if (d.media_kind === 'video') {
      const result = await this.call(d.provider_id, 'GET', { fields: 'status,permalink_url' });
      return { confirmed: result.status?.publishing_phase?.status === 'complete', url: safePostUrl(result.permalink_url) };
    }
    const result = await this.call(d.provider_id, 'GET', { fields: 'id,is_published,permalink_url' });
    return { confirmed: result.id === d.provider_id && result.is_published === true, url: safePostUrl(result.permalink_url) };
  }
  async reconcile(d: Delivery): Promise<PublicationProof> {
    this.check(d);
    await this.assertAccount(d.platform, d.account_id);
    if (d.provider_id) {
      // IDs informados pelo operador precisam pertencer à conta autorizada.
      if (d.platform === 'facebook' && d.format === 'story') {
        const result = await this.story({ ...d, container_id: null });
        if (result?.status === 'PUBLISHED') {
          return { outcome: 'published', provider_id: providerId(result.post_id ?? result.id ?? d.provider_id),
            url: safePostUrl(result.url), evidence: 'facebook_page_story' };
        }
      } else {
        const result = await this.call(d.provider_id, 'GET', {
          fields: d.platform === 'instagram' ? (d.format === 'story' ? 'id,timestamp,owner' : 'id,timestamp,owner,permalink')
            : d.media_kind === 'video' ? 'id,from,status,permalink_url' : 'id,is_published,from,permalink_url',
        });
        const owner = d.platform === 'instagram' ? result.owner : result.from;
        if (String(owner?.id) !== d.account_id) throw new MetaCommentError('meta_post_owner_mismatch');
        const confirmed = d.platform === 'instagram' ? typeof result.timestamp === 'string'
          : d.media_kind === 'video' ? result.status?.publishing_phase?.status === 'complete' : result.is_published === true;
        if (String(result.id) === d.provider_id && confirmed) {
          return { outcome: 'published', provider_id: d.provider_id,
            url: safePostUrl(result.permalink ?? result.permalink_url), evidence: 'provider_published_owned' };
        }
      }
    }
    if (d.container_id) {
      const result = await this.call(d.container_id, 'GET', { fields: d.platform === 'instagram' ? 'status_code' : 'status' });
      const terminal = d.platform === 'instagram' ? ['ERROR', 'EXPIRED'].includes(result.status_code)
        : d.media_kind === 'video' && ['error', 'failed'].includes(result.status?.publishing_phase?.status);
      if (terminal) return { outcome: 'not_published', evidence: 'provider_terminal_failure' };
    }
    // Ausência em listagem, 404 e estados em processamento nunca comprovam ausência de publicação.
    return { outcome: 'unknown', evidence: 'provider_result_ambiguous' };
  }
  async connections() {
    return Promise.all((['facebook', 'instagram'] as const).map(async platform => {
      let verified = false;
      try {
        await this.assertAccount(platform, accountId(platform));
        verified = true;
        const report = await this.permissions(platform);
        return { platform, verified, ...report,
          publish_allowed: report.permissions_checked && report.missing_permissions.length === 0 };
      } catch (error) {
        return { platform, verified, publish_allowed: false, permissions_checked: false,
          missing_permissions: [], error_code: error instanceof MetaCommentError ? error.code : 'publisher_service_unavailable' };
      }
    }));
  }
}
