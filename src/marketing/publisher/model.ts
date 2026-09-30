import { z } from 'zod';
import { META_BUSINESS_ACCOUNTS } from '../../shared/meta-business-accounts.js';

export type Environment = 'prod' | 'test';
export const idSchema = z.string().uuid().transform(value=>value.toLowerCase());
export const destinationSchema = z.object({
  platform: z.enum(['facebook','instagram']), format: z.enum(['feed','reel','story']),
  caption: z.string().max(2200).optional(),
}).strict();
export const draftSchema = z.object({
  version: z.number().int().min(0), title: z.string().trim().min(1).max(180),
  media_id: idSchema.nullable(), caption: z.string().max(2200),
  destinations: z.array(destinationSchema).max(2).refine(d => new Set(d.map(v => v.platform)).size === d.length),
  delete_after_publish: z.boolean().default(true),
}).strict();
export type Draft = z.infer<typeof draftSchema>;
export type Destination = z.infer<typeof destinationSchema>;
export const uploadSchema = z.object({
  id: idSchema, name: z.string().trim().min(1).max(180),
  mime: z.enum(['image/jpeg','image/png','image/webp','video/mp4','video/quicktime']),
  bytes: z.number().int().positive().max(500*1024*1024),
}).strict();
export const finalizeSchema = z.object({
  width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384),
  duration: z.number().min(0).max(1200).nullable(),
  thumbnail: z.string().max(280000).optional(),
}).strict();
export class PublisherError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
export const accountId = (platform: Destination['platform']) => META_BUSINESS_ACCOUNTS[platform].id;
export function validateFormats(kind: string, destinations: Destination[]): void {
  if (!destinations.length) throw new PublisherError('publisher_destination_required',400);
  for (const d of destinations) {
    if (kind === 'photo' && d.format === 'reel' || kind === 'video' && d.format === 'feed') {
      throw new PublisherError('publisher_format_incompatible',400);
    }
  }
}
export function publicationStatus(statuses: string[]): string {
  if (!statuses.length) return 'draft';
  if (statuses.every(s => s === 'published')) return 'published';
  if (statuses.some(s => ['queued','preparing','processing','publishing','verifying'].includes(s))) return 'publishing';
  if (statuses.some(s => s === 'published')) return 'partial';
  if (statuses.every(s => s === 'cancelled')) return 'cancelled';
  return 'failed';
}
