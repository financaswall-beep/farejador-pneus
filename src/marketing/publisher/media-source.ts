import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { PublisherError } from './model.js';
import type { PublisherStorage } from './storage.js';

const RANGE_BYTES = 4 * 1024 * 1024;
const BUDGET_BYTES = 48 * 1024 * 1024;

/** O decoder vê apenas um proxy local. Nem URL assinada nem service key chegam ao subprocesso. */
export async function withMediaSource<T>(storage: PublisherStorage, path: string, bytes: number,
  work: (url: string) => Promise<T>): Promise<T> {
  const route = `/${randomUUID()}`;
  let available = BUDGET_BYTES;
  let failure: PublisherError | undefined;
  const server = createServer(async (request, response) => {
    if (request.url !== route || !['GET', 'HEAD'].includes(request.method ?? '')) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'Content-Length': bytes, 'Accept-Ranges': 'bytes' }).end();
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? 'bytes=0-');
    const start = range ? Number(range[1]) : -1;
    if (!Number.isSafeInteger(start) || start < 0 || start >= bytes) {
      response.writeHead(416, { 'Content-Range': `bytes */${bytes}` }).end();
      return;
    }
    const requestedEnd = range?.[2] ? Number(range[2]) : bytes - 1;
    const end = Math.min(requestedEnd, start + RANGE_BYTES - 1, bytes - 1);
    if (!Number.isSafeInteger(end) || end < start || end - start + 1 > available) {
      failure = new PublisherError('publisher_media_probe_limit', 400);
      response.writeHead(413).end();
      return;
    }
    // Reserva antes de await: pedidos concorrentes nunca contornam a franquia de leitura.
    available -= end - start + 1;
    try {
      const data = await storage.readRange(path, start, end, bytes);
      response.writeHead(206, {
        'Content-Type': 'video/mp4', 'Content-Length': data.length,
        'Content-Range': `bytes ${start}-${end}/${bytes}`, 'Accept-Ranges': 'bytes',
      }).end(data);
    } catch (error) {
      failure = error instanceof PublisherError ? error : new PublisherError('publisher_storage_unavailable', 502);
      response.writeHead(502).end();
    }
  });
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    const result = await work(`http://127.0.0.1:${address.port}${route}`);
    if (failure) throw failure;
    return result;
  } catch (error) {
    throw failure ?? error;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
