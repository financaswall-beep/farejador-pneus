import { PublisherError, validateFormats, type Destination } from './model.js';
import type { Media } from './media.js';

/** Regras obrigatórias. 9:16 no Instagram Reel é recomendação, não bloqueio. */
export function validateDestinationMedia(media: Pick<Media, 'kind' | 'width' | 'height' | 'duration' | 'inspection'>,
  destinations: Destination[]): void {
  validateFormats(media.kind, destinations);
  const width = Number(media.width);
  const height = Number(media.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new PublisherError('publisher_media_dimensions_required', 400);
  }
  for (const destination of destinations) {
    if (media.kind === 'photo') {
      if (destination.platform === 'instagram' && destination.format === 'feed') {
        const ratio = width / height;
        if (ratio < 0.8 - 0.001 || ratio > 1.91 + 0.001) throw new PublisherError('publisher_instagram_feed_ratio', 400);
        if (width < 320 || width > 1440) throw new PublisherError('publisher_instagram_photo_width', 400);
      }
      continue;
    }
    const duration = Number(media.duration);
    const inspection = media.inspection;
    if (!inspection?.verified) throw new PublisherError('publisher_media_inspection_required', 400);
    if (!Number.isFinite(duration) || duration <= 0) throw new PublisherError('publisher_media_invalid', 400);
    if (!['h264', 'hevc'].includes(inspection.video_codec ?? '')) throw new PublisherError('publisher_video_codec', 400);
    if (destination.format === 'story' && duration > 60) throw new PublisherError('publisher_story_too_long', 400);
    if (destination.platform === 'instagram') {
      if (width > 1920) throw new PublisherError('publisher_instagram_video_width', 400);
      if (Number(inspection.fps) < 23 || Number(inspection.fps) > 60 || !inspection.fps) {
        throw new PublisherError('publisher_instagram_video_fps', 400);
      }
      if (Number(inspection.bit_rate) > 25_000_000) throw new PublisherError('publisher_instagram_video_bitrate', 400);
      if (inspection.audio_codec !== undefined) {
        if (inspection.audio_codec !== 'aac') throw new PublisherError('publisher_instagram_audio_codec', 400);
        const sampleRate = inspection.audio_sample_rate;
        // A Meta especifica um máximo de 48 kHz; AAC em 44,1 kHz também é válido.
        if (!Number.isInteger(sampleRate) || !sampleRate || sampleRate < 1 || sampleRate > 48_000) {
          throw new PublisherError('publisher_instagram_audio_sample_rate', 400);
        }
      }
      if (destination.format === 'reel' && (duration < 3 || duration > 900)) {
        throw new PublisherError('publisher_instagram_reel_duration', 400);
      }
    } else if (destination.format === 'reel') {
      if (duration < 4 || duration > 60) throw new PublisherError('publisher_facebook_reel_duration', 400);
      if (width < 540 || height < 960 || Math.abs(width / height - 9 / 16) > 0.01) {
        throw new PublisherError('publisher_facebook_reel_dimensions', 400);
      }
      if (Number(inspection.fps) < 24 || Number(inspection.fps) > 60 || !inspection.fps) {
        throw new PublisherError('publisher_facebook_video_fps', 400);
      }
    }
  }
}
