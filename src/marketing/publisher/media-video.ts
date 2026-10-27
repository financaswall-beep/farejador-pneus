import sharp from 'sharp';
import { mkdtemp, readFile, stat, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { parseVideoInspection } from './media-inspection.js';
import { runMediaProgram, type ProgramRunner } from './media-process.js';
import { PublisherError } from './model.js';
import { assertUploadPolicy, type BucketPolicy, type PublisherStorage } from './storage.js';
import { MAX_VIDEO_DERIVATIVE, preparedPath } from './media-formats.js';

export function videoOrientation(value: any): number {
  const video = value.streams?.find((stream: any) => stream.codec_type === 'video');
  const rotation = Number(video?.side_data_list?.find((side: any) => side.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0);
  if (!Number.isFinite(rotation) || rotation % 90 !== 0) throw new PublisherError('publisher_media_invalid', 400);
  return ((rotation % 360) + 360) % 360;
}
function parse(bytes: Buffer) {
  try { const raw = JSON.parse(bytes.toString()); return { raw, ...parseVideoInspection(raw), rotation: videoOrientation(raw) }; }
  catch { throw new PublisherError('publisher_media_invalid', 400); }
}
/** MP4/H.264, AAC e 9:16. O conteúdo inteiro é preservado; o limite de duração é validado por destino. */
export async function preparePublisherVideo(storage: PublisherStorage, path: string, bytes: number,
  policy: BucketPolicy, environment: string, id: string, runner: ProgramRunner = runMediaProgram) {
  const maxBytes = Math.min(MAX_VIDEO_DERIVATIVE, policy.maxBytes ?? MAX_VIDEO_DERIVATIVE);
  if (!Number.isSafeInteger(bytes) || bytes < 12 || bytes > 500 * 1024 * 1024) throw new PublisherError('publisher_media_invalid', 400);
  assertUploadPolicy(policy, 1, 'video/mp4');
  const directory = await mkdtemp(join(tmpdir(), 'publisher-video-'));
  const output = join(directory, 'vertical.mp4'), source = join(directory, 'input.mov');
  const common = ['-v', 'error', '-threads', '1', '-max_alloc', '67108864', '-probesize', '5242880', '-analyzeduration', '5000000'];
  const mov = ['-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0'];
  try {
    // Baixa uma vez em blocos limitados. O processo nativo só lê o arquivo local, nunca URLs ou credenciais.
    const input = await open(source, 'wx', 0o600);
    const downloadDeadline = Date.now() + 90_000;
    try {
      for (let offset = 0; offset < bytes; offset += 4 * 1024 * 1024) {
        if (Date.now() > downloadDeadline) throw new PublisherError('publisher_media_processing_timeout', 503);
        const end = Math.min(offset + 4 * 1024 * 1024, bytes) - 1;
        const part = await storage.readRange(path, offset, end, bytes);
        if (part.length !== end - offset + 1) throw new PublisherError('publisher_upload_mismatch', 400);
        await input.writeFile(part);
      }
    } finally { await input.close(); }
    const local = ['-protocol_whitelist', 'file'];
    const original = parse(await runner('ffprobe', [...common, ...local, ...mov, '-show_streams', '-show_format', '-of', 'json', source]));
    const bitrate = Math.min(5_000_000, Math.floor((maxBytes - 1024 * 1024) * 8 / original.duration * 0.92) - 128_000);
    if (bitrate < 128_000) throw new PublisherError('publisher_video_output_too_large', 413);
    const rotate = original.rotation === 90 ? 'transpose=cclock,' : original.rotation === 270 ? 'transpose=clock,' : original.rotation === 180 ? 'hflip,vflip,' : '';
    const video = original.raw.streams.find((stream: any) => stream.codec_type === 'video');
    const hdr = ['smpte2084', 'arib-std-b67'].includes(video.color_transfer)
      ? 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,' : '';
    const scale = "scale=w='if(gte(dar,9/16),1080,max(2,trunc(1920*dar/2)*2))':h='if(gte(dar,9/16),max(2,trunc(1080/dar/2)*2),1920)'";
    const filter = `${rotate}${hdr}${scale},setsar=1,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0xf4f5f3,fps=30,format=yuv420p`;
    await runner('ffmpeg', [...common, '-nostdin', '-y', ...local, ...mov, '-noautorotate', '-display_rotation:v:0', '0', '-i', source,
      '-filter_threads', '1', '-vf', filter, '-map', '0:v:0', '-map', '0:a:0?', '-t', String(original.duration),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-profile:v', 'high', '-level:v', '4.1',
      '-maxrate', String(bitrate), '-bufsize', String(bitrate * 2), '-threads', '2',
      '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-ar', '48000', '-map_metadata', '-1', '-map_chapters', '-1',
      '-metadata:s:v:0', 'rotate=0', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart', output],
    256 * 1024, { timeoutMs: 180_000, cpuSeconds: 150, maxFileBytes: maxBytes + 1024 * 1024 });
    const size = (await stat(output)).size;
    if (!size || size > maxBytes) throw new PublisherError('publisher_video_output_too_large', 413);
    assertUploadPolicy(policy, size, 'video/mp4');
    const final = parse(await runner('ffprobe', [...common, '-protocol_whitelist', 'file', ...mov, '-show_streams', '-show_format', '-of', 'json', output]));
    if (final.width !== 1080 || final.height !== 1920 || final.rotation !== 0 || final.inspection.video_codec !== 'h264'
      || Math.abs(final.duration - original.duration) > 0.25 || final.inspection.fps !== 30
      || final.inspection.audio_codec && (final.inspection.audio_codec !== 'aac' || final.inspection.audio_sample_rate !== 48000)) {
      throw new PublisherError('publisher_media_invalid', 400);
    }
    const image = await runner('ffmpeg', [...common, '-protocol_whitelist', 'file', ...mov, '-i', output,
      '-filter_threads', '1', '-frames:v', '1', '-vf', 'scale=400:400:force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], 2 * 1024 * 1024);
    const thumbnail = await sharp(image, { limitInputPixels: 2_000_000 }).jpeg({ quality: 72 }).toBuffer();
    const publishPath = preparedPath(environment, id, 'video', 'story');
    await storage.put(publishPath, await readFile(output), 'video/mp4');
    return { publishPath, width: final.width, height: final.height, duration: final.duration, thumbnail,
      inspection: { ...final.inspection, prepared: { version: 1 as const, profiles: { vertical: { width: final.width, height: final.height, bytes: size } } } } };
  } finally {
    if (resolve(directory).startsWith(resolve(tmpdir()) + sep + 'publisher-video-')) await rm(directory, { recursive: true, force: true });
  }
}
