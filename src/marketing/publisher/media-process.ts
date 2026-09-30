import { spawn } from 'node:child_process';
import { PublisherError } from './model.js';

export type MediaProgram = 'ffprobe' | 'ffmpeg' | 'heif-info' | 'heif-convert';
export type ProgramRunner = (program: MediaProgram, args: string[], maxOutput?: number) => Promise<Buffer>;

/** Sem shell, com tempo/saída limitados; Linux limita também memória e CPU do decodificador. */
export const runMediaProgram: ProgramRunner = (program, args, maxOutput = 256 * 1024) => new Promise((resolve, reject) => {
  const limits = ['--as=1073741824', '--cpu=40', '--nofile=64', '--fsize=33554432', '--', program];
  const child = spawn(process.platform === 'linux' ? 'prlimit' : program,
    process.platform === 'linux' ? [...limits, ...args] : args,
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const parts: Buffer[] = [];
  let bytes = 0;
  let failure: PublisherError | undefined;
  const stop = (error: PublisherError) => {
    failure = error;
    child.kill('SIGKILL');
  };
  const timer = setTimeout(() => stop(new PublisherError('publisher_media_processing_timeout', 503)), 60_000);
  child.stdout.on('data', (part: Buffer) => {
    bytes += part.length;
    if (bytes > maxOutput) stop(new PublisherError('publisher_media_invalid', 400));
    else parts.push(part);
  });
  child.once('error', () => {
    clearTimeout(timer);
    reject(new PublisherError('publisher_media_processor_missing', 503));
  });
  child.once('close', code => {
    clearTimeout(timer);
    if (failure) reject(failure);
    else if (code !== 0) reject(new PublisherError('publisher_media_invalid', 400));
    else resolve(Buffer.concat(parts));
  });
});

let active = 0;
export async function withMediaSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 2) throw new PublisherError('publisher_media_processing_busy', 503);
  active++;
  try { return await work(); } finally { active--; }
}
