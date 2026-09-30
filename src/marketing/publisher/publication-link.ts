import { MetaCommentError } from '../../social-comments/graph.js';
import type { Destination } from './model.js';
import type { Delivery } from './graph.js';

export interface PublicationLink {
  key: string;
  kind: 'post' | 'media' | 'story';
  id: string;
}
type GraphRead = (path: string, params: Record<string, string>) => Promise<Record<string, any>>;
const objectId = /^\d{1,40}(?:_\d{1,40})?$/;
const postId = /^(?:\d{1,40}|pfbid[A-Za-z0-9]{1,150})$/;

/** Interpreta apenas links permanentes. Nunca acessa a URL colada nem segue seus redirects. */
export function parsePublicationLink(value: string, platform: Destination['platform']): PublicationLink {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new MetaCommentError('publisher_post_url_invalid'); }
  if (value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.port
    || !/^(?:www\.|m\.|mbasic\.)?(?:instagram|facebook)\.com$/.test(url.hostname)) {
    throw new MetaCommentError('publisher_post_url_invalid');
  }
  if (!url.hostname.endsWith(platform + '.com')) throw new MetaCommentError('publisher_post_url_platform');
  const path = url.pathname.replace(/\/$/, '');
  if (platform === 'instagram') {
    const media = /^\/(?:p|reel|reels)\/([A-Za-z0-9_-]{1,100})$/.exec(path);
    if (media) return { key: 'instagram:media:' + media[1], kind: 'media', id: media[1]! };
    // A identificação web de um Story não é o ID da Graph API. Use o ID para este formato.
    throw new MetaCommentError('publisher_post_url_unsupported');
  }
  const post = /^\/[^/]+\/posts\/([^/]+)$/.exec(path);
  const queryPost = ['/permalink.php', '/story.php'].includes(path) ? url.searchParams.get('story_fbid') : null;
  const id = post?.[1] ?? queryPost;
  if (id && postId.test(id)) return { key: 'facebook:post:' + id, kind: 'post', id };
  const video = /^\/(?:reel|[^/]+\/videos)\/(\d{1,40})$/.exec(path);
  const queryMedia = path === '/watch' ? url.searchParams.get('v')
    : ['/photo', '/photo.php'].includes(path) ? url.searchParams.get('fbid') : null;
  const mediaId = video?.[1] ?? queryMedia;
  if (mediaId && /^\d{1,40}$/.test(mediaId)) {
    return { key: 'facebook:media:' + mediaId, kind: 'media', id: mediaId };
  }
  const story = /^\/stories\/\d{1,40}\/(\d{1,40})$/.exec(path);
  if (story) return { key: 'facebook:story:' + story[1], kind: 'story', id: story[1]! };
  throw new MetaCommentError('publisher_post_url_unsupported');
}

function matchesLink(value: unknown, link: PublicationLink, platform: Destination['platform']): boolean {
  if (typeof value !== 'string') return false;
  try { return parsePublicationLink(value, platform).key === link.key; }
  catch { return false; }
}

/** Resolve o código do link somente em leituras da conta fixada, com paginação limitada. */
export async function resolvePublicationLink(d: Delivery, link: PublicationLink, read: GraphRead): Promise<string | null> {
  if ((link.kind === 'story') !== (d.format === 'story')) {
    throw new MetaCommentError('publisher_post_url_format');
  }
  if (d.platform === 'facebook' && /^\d+$/.test(link.id)) {
    // A confirmação posterior verifica proprietário e publicação, inclusive para IDs extraídos do link.
    return link.kind === 'post' ? d.account_id + '_' + link.id : link.id;
  }
  let after: string | undefined;
  const cursors = new Set<string>();
  for (let page = 0; page < 3; page++) {
    const result = await read(d.account_id + (d.platform === 'instagram' ? '/media' : '/published_posts'), {
      fields: d.platform === 'instagram' ? 'id,permalink' : 'id,permalink_url',
      limit: '100', ...(after ? { after } : {}),
    });
    if (!Array.isArray(result.data)) throw new MetaCommentError('meta_publications_invalid_response');
    for (const item of result.data) {
      if (item && typeof item.id === 'string' && objectId.test(item.id)
        && matchesLink(item.permalink ?? item.permalink_url, link, d.platform)) return item.id;
    }
    const cursor = result.paging?.cursors?.after;
    // paging.next pode conter token e host externo; usar somente o cursor no host Graph fixado.
    if (!result.paging?.next || typeof cursor !== 'string' || !cursor || cursor.length > 3000 || cursors.has(cursor)) break;
    cursors.add(cursor);
    after = cursor;
  }
  return null; // Não encontrar o link nunca comprova que a publicação falhou.
}
