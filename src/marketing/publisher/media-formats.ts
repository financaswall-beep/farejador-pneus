import type { Media } from './media.js';
import type { MediaInspection } from './media-inspection.js';

export const MAX_PHOTO_DERIVATIVES = 8 * 1024 * 1024;
export const MAX_PHOTO_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_VIDEO_DERIVATIVE = 300 * 1024 * 1024;
export const profileName = (format: string) => format === 'feed' ? 'feed' : 'vertical';
export const preparedPath = (environment: string, id: string, kind: string, format: string) =>
  `${environment}/${id}/${profileName(format)}-v1.${kind === 'photo' ? 'jpg' : 'mp4'}`;

export function preparedDimensions(media: Pick<Media, 'width' | 'height' | 'inspection'>, format: string) {
  const profile = media.inspection?.prepared?.version === 1 ? media.inspection.prepared.profiles[profileName(format)] : undefined;
  return profile ? { width: profile.width, height: profile.height } : { width: media.width, height: media.height };
}
export function preparedPublishPath(media: { kind: string; inspection?: MediaInspection; publish_path: string | null; original_path: string }, format: string) {
  if (media.inspection?.prepared?.version !== 1 || !media.inspection.prepared.profiles[profileName(format)]) return media.publish_path ?? media.original_path;
  const directory = media.original_path.slice(0, media.original_path.lastIndexOf('/'));
  return `${directory}/${profileName(format)}-v1.${media.kind === 'photo' ? 'jpg' : 'mp4'}`;
}
export function preparationReady(media: Pick<Media, 'kind' | 'inspection'>) {
  const profiles = media.inspection?.prepared?.version === 1 && media.inspection.prepared.profiles;
  return Boolean(profiles && profiles.vertical && (media.kind === 'video' || profiles.feed));
}
