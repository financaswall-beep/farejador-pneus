import sharp from 'sharp';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { PublisherError } from './model.js';
import { runMediaProgram, type ProgramRunner } from './media-process.js';
import { withMediaSource } from './media-source.js';
import type { PublisherStorage } from './storage.js';

export interface MediaInspection {
  verified: boolean;
  video_codec?: string;
  fps?: number;
  bit_rate?: number;
  audio_codec?: string;
  audio_sample_rate?: number;
  audio_channels?: number;
}
interface ProbeStream {
  codec_type?: string; codec_name?: string; width?: number; height?: number;
  avg_frame_rate?: string; r_frame_rate?: string; bit_rate?: string;
  sample_rate?: string; channels?: number; duration?: string;
  side_data_list?: { rotation?: number }[];
}
export function parseVideoInspection(value: unknown) {
  const data = value as { streams?: ProbeStream[]; format?: { duration?: string; bit_rate?: string } };
  if (!data || !Array.isArray(data.streams)) throw new PublisherError('publisher_media_invalid', 400);
  const videos = data.streams.filter(stream => stream.codec_type === 'video');
  const audio = data.streams.find(stream => stream.codec_type === 'audio');
  const video = videos[0];
  if (videos.length !== 1 || !video) throw new PublisherError('publisher_media_invalid', 400);
  const rate = (video.avg_frame_rate ?? video.r_frame_rate ?? '').split('/').map(Number);
  const fps = rate.length === 2 ? Number(rate[0]) / Number(rate[1]) : Number(rate[0]);
  const duration = Number(data.format?.duration ?? video.duration);
  let width = Number(video.width);
  let height = Number(video.height);
  const rotation = Math.abs(Number(video.side_data_list?.find(side => side.rotation !== undefined)?.rotation ?? 0)) % 180;
  if (rotation === 90) [width, height] = [height, width];
  if (![width, height].every(dimension => Number.isInteger(dimension) && dimension > 0 && dimension <= 8192)
    || width * height > 40_000_000 || !Number.isFinite(duration) || duration <= 0 || duration > 1200
    || !Number.isFinite(fps) || fps <= 0 || fps > 240) {
    throw new PublisherError('publisher_media_invalid', 400);
  }
  const inspection: MediaInspection = {
    verified: true, video_codec: video.codec_name ?? '', fps,
    bit_rate: Number(video.bit_rate ?? data.format?.bit_rate) || 0,
    ...(audio ? { audio_codec: audio.codec_name ?? '', audio_sample_rate: Number(audio.sample_rate) || 0,
      audio_channels: Number(audio.channels) || 0 } : {}),
  };
  return { width, height, duration, inspection };
}

export async function inspectVideo(storage: PublisherStorage, path: string, bytes: number,
  runner: ProgramRunner = runMediaProgram) {
  return withMediaSource(storage, path, bytes, async url => {
    const common = ['-v', 'error', '-threads', '1', '-max_alloc', '67108864',
      '-protocol_whitelist', 'http,tcp', '-rw_timeout', '10000000', '-probesize', '5242880', '-analyzeduration', '5000000'];
    const probe = await runner('ffprobe', [...common, '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0',
      '-show_streams', '-show_format', '-of', 'json', url]);
    let value: unknown;
    try { value = JSON.parse(probe.toString()); } catch { throw new PublisherError('publisher_media_invalid', 400); }
    const metadata = parseVideoInspection(value);
    const image = await runner('ffmpeg', [...common, '-filter_threads', '1', '-f', 'mov', '-enable_drefs', '0',
      '-use_absolute_path', '0', '-i', url, '-map', '0:v:0', '-frames:v', '1',
      '-vf', 'scale=400:400:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], 2 * 1024 * 1024);
    const thumbnail = await sharp(image, { limitInputPixels: 2_000_000 }).jpeg({ quality: 72 }).toBuffer();
    return { ...metadata, thumbnail };
  });
}

export async function decodeHeic(input: Buffer, runner: ProgramRunner = runMediaProgram): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'publisher-heic-'));
  const source = join(directory, 'input.heic');
  const output = join(directory, 'output.jpg');
  try {
    await writeFile(source, input, { mode: 0o600 });
    const info = (await runner('heif-info', [source])).toString();
    // Um arquivo com várias imagens principais geraria saídas e trabalho sem limite.
    if ([...info.matchAll(/^image:/gm)].length !== 1) throw new PublisherError('publisher_media_invalid', 400);
    const dimensions = [...info.matchAll(/(\d+)x(\d+)/g)];
    if (!dimensions.length || dimensions.some(match => {
      const width = Number(match[1]);
      const height = Number(match[2]);
      return width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 40_000_000;
    })) throw new PublisherError('publisher_media_invalid', 400);
    await runner('heif-convert', ['-q', '90', source, output]);
    if ((await stat(output)).size > 32 * 1024 * 1024) throw new PublisherError('publisher_media_too_large', 413);
    return await readFile(output);
  } finally {
    if (resolve(directory).startsWith(`${resolve(tmpdir())}${sep}publisher-heic-`)) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
