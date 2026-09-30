import { describe, it, expect } from 'vitest';
import type { Media } from '../../../src/marketing/publisher/media.js';
import { validateDestinationMedia } from '../../../src/marketing/publisher/media-validation.js';
import { parseVideoInspection } from '../../../src/marketing/publisher/media-inspection.js';
const video = { kind: 'video', width: 1080, height: 1920, duration: '10',
  inspection: { verified: true, video_codec: 'h264', fps: 30, bit_rate: 8_000_000,
    audio_codec: 'aac', audio_sample_rate: 48000 } } as Media;
const reel = [{ platform: 'instagram', format: 'reel' }] as const;
const validate = (media: Media) => validateDestinationMedia(media, [...reel]);

describe('Arquivo efetivo e regras por destino', () => {
  it('obtém dimensões orientadas, duração e codecs do probe sem aceitar metadados do navegador', () => {
    const result = parseVideoInspection({ streams: [
      { codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, avg_frame_rate: '30000/1001',
        side_data_list: [{ rotation: -90 }], bit_rate: '12000000' },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
    ], format: { duration: '50.12' } });
    expect(result).toMatchObject({ width: 1080, height: 1920, duration: 50.12,
      inspection: { verified: true, video_codec: 'hevc', audio_codec: 'aac', audio_sample_rate: 48000, audio_channels: 2 } });
    expect(result.inspection.fps).toBeCloseTo(29.97, 2);
  });
  it('rejeita probe sem vídeo único, dimensões excessivas, duração ou frame rate inválidos', () => {
    for (const stream of [{ width: 99999, height: 1, avg_frame_rate: '30/1' },
      { width: 1080, height: 1920, avg_frame_rate: '0/0' }]) {
      expect(() => parseVideoInspection({ streams: [{ codec_type: 'video', ...stream }], format: { duration: '10' } })).toThrow('publisher_media_invalid');
    }
    expect(() => parseVideoInspection({ streams: [] })).toThrow('publisher_media_invalid');
  });
  it('aceita Reel Instagram horizontal, mas bloqueia curto/codec/fps/bitrate incompatíveis', () => {
    expect(() => validate({ ...video, width: 1920, height: 1080 })).not.toThrow();
    expect(() => validate({ ...video, duration: '2.9' })).toThrow('publisher_instagram_reel_duration');
    expect(() => validate({ ...video, inspection: {} as Media['inspection'] })).toThrow('publisher_media_inspection_required');
    expect(() => validate({ ...video, inspection: { ...video.inspection!, video_codec: 'vp9' } })).toThrow('publisher_video_codec');
    expect(() => validate({ ...video, inspection: { ...video.inspection!, fps: 120 } })).toThrow('publisher_instagram_video_fps');
    expect(() => validate({ ...video, inspection: { ...video.inspection!, bit_rate: 56_000_000 } })).toThrow('publisher_instagram_video_bitrate');
  });
  it.each([44100, 48000])('aceita AAC em %i Hz em Reel e Story do Instagram', sampleRate => {
    const media = { ...video, inspection: { ...video.inspection!, audio_sample_rate: sampleRate } };
    for (const format of ['reel', 'story'] as const) {
      expect(() => validateDestinationMedia(media, [{ platform: 'instagram', format }])).not.toThrow();
    }
  });
  it.each([96000, 48001, 0, -1, 44100.5, NaN, undefined])('rejeita taxa AAC incompatível ou não verificada: %s', sampleRate => {
    expect(() => validate({ ...video, inspection: { ...video.inspection!, audio_sample_rate: sampleRate } }))
      .toThrow('publisher_instagram_audio_sample_rate');
  });
  it('permite vídeo sem áudio, mas recusa codec diferente de AAC ou desconhecido', () => {
    const { audio_codec, audio_sample_rate, ...silent } = video.inspection!;
    expect(() => validate({ ...video, inspection: silent })).not.toThrow();
    for (const codec of ['opus', 'mp3', '']) {
      expect(() => validate({ ...video, inspection: { ...video.inspection!, audio_codec: codec } }))
        .toThrow('publisher_instagram_audio_codec');
    }
  });
  it('confere Feed foto e duração/dimensões Facebook separadamente', () => {
    const photo = { kind: 'photo', width: 1080, height: 1920 } as Media;
    expect(() => validateDestinationMedia(photo, [{ platform: 'instagram', format: 'feed' }])).toThrow('publisher_instagram_feed_ratio');
    expect(() => validateDestinationMedia({ ...photo, height: 1350 }, [{ platform: 'instagram', format: 'feed' }])).not.toThrow();
    expect(() => validateDestinationMedia({ ...video, duration: '3.5' }, [{ platform: 'facebook', format: 'reel' }])).toThrow('publisher_facebook_reel_duration');
    expect(() => validateDestinationMedia({ ...video, width: 1920, height: 1080 }, [{ platform: 'facebook', format: 'reel' }])).toThrow('publisher_facebook_reel_dimensions');
    expect(() => validateDestinationMedia({ ...video, duration: '61' }, [{ platform: 'facebook', format: 'story' }])).toThrow('publisher_story_too_long');
  });
});
