import { createHmac } from 'node:crypto';
import { ownsAccount, type CommentsConfig, type Platform } from './config.js';

export class MetaCommentError extends Error {
  constructor(public readonly code: string, public readonly uncertain = false) { super(code); }
}
type Json = Record<string, any>;
/** Fixed Graph host, no provider paging URLs, no tokens/payloads in errors. Facebook Login. */
export class CommentsGraph {
  constructor(private config: CommentsConfig, private fetcher: typeof fetch = fetch) {}
  private async call(path: string, method = 'GET', params: Record<string,string> = {}, token = this.config.token): Promise<Json> {
    if (!token) throw new MetaCommentError('meta_token_missing');
    if (!/^[a-z0-9_/]+$/i.test(path) || !/^v\d+\.\d+$/.test(this.config.apiVersion)) {
      throw new MetaCommentError('meta_invalid_path');
    }
    const url = new URL(`https://graph.facebook.com/${this.config.apiVersion}/${path}`);
    const values = new URLSearchParams(params);
    if (this.config.appSecret) values.set('appsecret_proof',createHmac('sha256',this.config.appSecret).update(token).digest('hex'));
    if (method === 'GET' || method === 'DELETE') url.search = values.toString();
    let response: Response;
    try {
      response = await this.fetcher(url, { method, redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        ...(method === 'POST' ? { body: values.toString() } : {}), signal: AbortSignal.timeout(15_000) });
    } catch { throw new MetaCommentError('meta_connection_unknown',method !== 'GET'); }
    let body: Json;
    try { body = await response.json() as Json; }
    catch { throw new MetaCommentError('meta_response_unknown',method !== 'GET'); }
    if (!response.ok || body.error) {
      const code = Number(body.error?.code);
      throw new MetaCommentError(`meta_http_${response.status}_code_${Number.isFinite(code) ? code : 0}`,
        method !== 'GET' && response.status >= 500);
    }
    return body;
  }
  async assertAccount(platform: Platform, account: string): Promise<void> {
    if (!ownsAccount(this.config,platform,account)) throw new MetaCommentError('meta_account_not_allowed');
    const actor = await this.call('me','GET',{fields:platform === 'facebook' ? 'id' : 'id,instagram_business_account'});
    if (String(actor.id) !== this.config.pageId) throw new MetaCommentError('meta_token_page_mismatch');
    if (platform === 'instagram' && String(actor.instagram_business_account?.id) !== account) {
      throw new MetaCommentError('meta_token_instagram_mismatch');
    }
  }
  async post(platform: Platform, account: string, post: string): Promise<{ caption: string; url: string | null }> {
    if (!ownsAccount(this.config,platform,account)) throw new MetaCommentError('meta_account_not_allowed');
    const data = await this.call(post,'GET',{fields: platform === 'facebook' ? 'id,message,permalink_url,from' : 'id,caption,permalink,owner'});
    if (String((platform === 'facebook' ? data.from : data.owner)?.id) !== account) {
      throw new MetaCommentError('meta_post_owner_mismatch');
    }
    return { caption: String(data.message ?? data.caption ?? '').slice(0,6000), url: safePostUrl(data.permalink_url ?? data.permalink) };
  }
  async comment(platform: Platform, comment: string): Promise<{ body: string; authorId: string | null }> {
    const data = await this.call(comment,'GET',{fields: platform === 'facebook' ? 'id,message,from' : 'id,text,from'});
    if (String(data.id) !== comment) throw new MetaCommentError('meta_comment_mismatch');
    return { body: String(data.message ?? data.text ?? ''), authorId: data.from?.id ? String(data.from.id) : null };
  }
  async reply(platform: Platform, comment: string, message: string): Promise<string> {
    const data = await this.call(`${comment}/${platform === 'facebook' ? 'comments' : 'replies'}`,'POST',{message});
    if (typeof data.id !== 'string' || !/^[0-9_]+$/.test(data.id)) throw new MetaCommentError('meta_ack_unknown',true);
    return data.id;
  }
  async remove(comment: string): Promise<void> {
    const data = await this.call(comment,'DELETE');
    if (data.success !== true) throw new MetaCommentError('meta_delete_ack_unknown',true);
  }
  async health(): Promise<Record<string,unknown>> {
    const page = await this.call('me','GET',{fields:'id,name,instagram_business_account'});
    const pageMatches = String(page.id) === this.config.pageId;
    let scopes: string[] | null = null;
    let tokenValid: boolean | null = null;
    let appMatches: boolean | null = null;
    if (this.config.appId && this.config.appSecret && this.config.token) {
      const debug = await this.call('debug_token','GET',{input_token:this.config.token},`${this.config.appId}|${this.config.appSecret}`);
      scopes = Array.isArray(debug.data?.scopes) ? debug.data.scopes.filter((x: unknown) => typeof x === 'string') : [];
      tokenValid = debug.data?.is_valid === true;
      appMatches = String(debug.data?.app_id) === this.config.appId;
    }
    const needed = { facebook:['pages_read_engagement','pages_read_user_content','pages_manage_engagement'],
      instagram:['instagram_basic','instagram_manage_comments','pages_read_engagement'] };
    return { page_matches:pageMatches, token_valid:tokenValid, app_matches:appMatches,
      instagram_matches: Boolean(this.config.instagramId && String(page.instagram_business_account?.id) === this.config.instagramId),
      permissions_checked:scopes !== null,
      facebook_missing:scopes ? needed.facebook.filter(x=>!scopes.includes(x)) : null,
      instagram_missing:scopes ? needed.instagram.filter(x=>!scopes.includes(x)) : null,
      note:'Esta verificação lê a conta e as permissões. O recebimento depende da assinatura dos webhooks na Meta.' };
  }
}
export function safePostUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^(www\.)?(facebook|instagram)\.com$/.test(url.hostname) && !url.username && !url.password
      ? url.toString() : null;
  } catch { return null; }
}
