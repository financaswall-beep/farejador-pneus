import { createHash } from 'node:crypto';
import { ownsAccount, type CommentsConfig, type Platform } from './config.js';

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const id = (v: unknown): string => typeof v === 'string' && /^[0-9_]{1,100}$/.test(v) ? v : '';
const text = (v: unknown, max = 8000): string => typeof v === 'string' ? v.slice(0,max) : '';
export function commentRevision(body: string, removed = false): string {
  return createHash('sha256').update(JSON.stringify([body,removed])).digest('hex');
}
export interface CommentEvent {
  platform: Platform; accountId: string; commentId: string; postId: string;
  parentId: string | null; authorId: string | null; authorLabel: string;
  body: string; removed: boolean; own: boolean; occurredAt: Date; eventAt: Date;
}
/** Structural mapping only. No sentiment, keyword filters or LLM in the webhook. */
export function extractComments(payload: unknown, config: CommentsConfig, receivedAt = new Date()): CommentEvent[] {
  const root = object(payload);
  if (root.object !== 'page' && root.object !== 'instagram') return [];
  const platform: Platform = root.object === 'page' ? 'facebook' : 'instagram';
  const result: CommentEvent[] = [];
  for (const rawEntry of Array.isArray(root.entry) ? root.entry : []) {
    const entry = object(rawEntry), accountId = id(entry.id);
    if (!ownsAccount(config,platform,accountId)) continue;
    const eventTime = Number(entry.time);
    const eventAt = Number.isFinite(eventTime) && eventTime > 0
      ? new Date(eventTime > 1e12 ? eventTime : eventTime * 1000) : receivedAt;
    if (!Number.isFinite(eventAt.getTime())) continue;
    for (const rawChange of Array.isArray(entry.changes) ? entry.changes : []) {
      const change = object(rawChange), value = object(change.value), author = object(value.from);
      if (platform === 'facebook' ? change.field !== 'feed' || value.item !== 'comment'
        : change.field !== 'comments') continue;
      const removed = value.verb === 'remove';
      if (platform === 'facebook' && !['add','edited','edit','remove'].includes(String(value.verb))) continue;
      const commentId = id(platform === 'facebook' ? value.comment_id : value.id);
      const postId = id(platform === 'facebook' ? value.post_id : object(value.media).id);
      if (!commentId || !postId) continue;
      const parentId = id(value.parent_id);
      const authorId = id(author.id);
      const createdTime = Number(value.created_time);
      result.push({ platform, accountId, commentId, postId, parentId: parentId && parentId !== postId ? parentId : null,
        authorId: authorId || null, authorLabel: text(author.name ?? author.username,200) || 'Visitante',
        body: text(platform === 'facebook' ? value.message : value.text), removed,
        own: authorId === config.pageId || authorId === config.instagramId,
        occurredAt: Number.isFinite(createdTime) && createdTime > 0 ? new Date(createdTime * 1000) : eventAt,
        eventAt,
      });
    }
  }
  return result;
}
