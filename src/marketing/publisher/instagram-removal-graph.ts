import { env } from '../../shared/config/env.js';
import { commentsConfig, ownsAccount, type CommentsConfig } from '../../social-comments/config.js';
import { CommentsGraph, MetaCommentError } from '../../social-comments/graph.js';

export class InstagramRemovalGraph extends CommentsGraph {
  constructor(private readonly settings: CommentsConfig = commentsConfig(),
    private readonly userToken = env.META_INSTAGRAM_DELETE_USER_TOKEN, fetcher: typeof fetch = fetch) {
    super(settings, fetcher);
  }

  async removePublishedMedia(account: string, mediaId: string): Promise<void> {
    if (!ownsAccount(this.settings, 'instagram', account) || !/^\d{1,40}$/.test(mediaId)) {
      throw new MetaCommentError('publisher_removal_target_invalid');
    }
    const { appId, appSecret } = this.settings;
    if (!this.userToken || !appId || !appSecret) throw new MetaCommentError('publisher_removal_credentials_missing');
    const debug = await this.call('debug_token', 'GET', { input_token: this.userToken }, appId + '|' + appSecret);
    const token = debug.data;
    if (token?.is_valid !== true || token.type !== 'USER' || String(token.app_id) !== appId ||
        [token.expires_at, token.data_access_expires_at].some(t => Number(t) > 0 && Number(t) <= Date.now() / 1000)) {
      throw new MetaCommentError('publisher_removal_user_token_invalid');
    }
    for (const scope of ['instagram_basic', 'instagram_manage_contents']) {
      const grant = Array.isArray(token.granular_scopes)
        ? token.granular_scopes.find((item: {scope?: string}) => item.scope === scope) : undefined;
      if (!Array.isArray(token.scopes) || !token.scopes.includes(scope) ||
          (Array.isArray(grant?.target_ids) && !grant.target_ids.includes(account))) {
        throw new MetaCommentError('publisher_removal_permission_missing');
      }
    }
    // Leitura com o mesmo token que executará o DELETE, inclusive para posts antigos e Stories.
    const media = await this.call(mediaId, 'GET', { fields: 'id,owner' }, this.userToken);
    if (String(media.id) !== mediaId || String(media.owner?.id) !== account) {
      throw new MetaCommentError('meta_post_owner_mismatch');
    }
    try {
      const receipt = await this.call(mediaId, 'DELETE', {}, this.userToken);
      if (receipt.success !== true || String(receipt.deleted_id) !== mediaId) {
        throw new MetaCommentError('publisher_removal_receipt_unknown', true);
      }
    } catch (error) {
      if (error instanceof MetaCommentError && error.code.startsWith('meta_http_408_')) {
        throw new MetaCommentError('publisher_removal_receipt_unknown', true);
      }
      if (error instanceof MetaCommentError) throw error;
      throw new MetaCommentError('publisher_removal_receipt_unknown', true);
    }
  }
}
