import { env } from '../shared/config/env.js';

export type Platform = 'facebook' | 'instagram';
// Escopo autorizado pelo dono. A nova Página 2W Pneus foi vinculada ao @2wp.pneus.
// Não aceitar IDs arbitrários do ambiente: um erro de configuração não pode responder em outra conta.
export const COMMENT_ACCOUNTS = Object.freeze({
  facebook: Object.freeze({id:'1434857906367394',label:'2W Pneus'}),
  instagram: Object.freeze({id:'17841465774227389',label:'@2wp.pneus'}),
});
export interface CommentsConfig {
  enabled: boolean; publish: boolean; pageId?: string; instagramId?: string;
  token?: string; appId?: string; appSecret?: string; apiVersion: string; scopeValid?: boolean;
}
export function commentsConfig(): CommentsConfig {
  // As variáveis só podem confirmar os IDs fixados; não podem ampliar o escopo.
  const scopeValid = (!env.META_COMMENTS_PAGE_ID || env.META_COMMENTS_PAGE_ID === COMMENT_ACCOUNTS.facebook.id)
    && (!env.META_COMMENTS_INSTAGRAM_ID || env.META_COMMENTS_INSTAGRAM_ID === COMMENT_ACCOUNTS.instagram.id);
  return {
    enabled: env.META_COMMENTS_ENABLED && scopeValid, publish: env.META_COMMENTS_PUBLISH_ENABLED && scopeValid,
    pageId: COMMENT_ACCOUNTS.facebook.id, instagramId: COMMENT_ACCOUNTS.instagram.id, scopeValid,
    token: env.META_COMMENTS_PAGE_ACCESS_TOKEN, appId: env.META_COMMENTS_APP_ID,
    appSecret: env.META_APP_SECRET, apiVersion: env.META_GRAPH_API_VERSION,
  };
}
export function ownsAccount(config: CommentsConfig, platform: Platform, id: string): boolean {
  return Boolean(config.scopeValid !== false && id && id === (platform === 'facebook' ? config.pageId : config.instagramId));
}
