import { get } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { callbackUrl, resolvePublicAddress } from './events/https.js';
import { PublisherError } from '../../marketing/publisher/model.js';

async function openFile(url: URL, signal: AbortSignal) {
  const address = await resolvePublicAddress(url);
  return new Promise<IncomingMessage>((resolve, reject) => {
    get(url, { signal, agent: false, family: address.family, ...{autoSelectFamily:false},
      lookup: (_host, _options, done) => done(null, address.address, address.family),
    }, resolve).on('error', () => reject(new PublisherError('publisher_attachment_unavailable', 502)));
  });
}

/** Valida e fixa DNS em cada destino. O vídeo é gravado em disco com limite de bytes. */
export async function downloadPublisherFile(raw: string, file: string, maxBytes: number) {
  const signal = AbortSignal.timeout(180_000);
  let url = callbackUrl(raw);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await openFile(url, signal);
    try {
      const status = response.statusCode ?? 0;
      if ([301,302,303,307,308].includes(status) && response.headers.location) {
        url = callbackUrl(new URL(response.headers.location, url).href);
        continue;
      }
      if (status !== 200) throw new PublisherError('publisher_attachment_unavailable', 502);
      const length = Number(response.headers['content-length']);
      if (length > maxBytes) throw new PublisherError('publisher_media_too_large', 413);
      let bytes = 0;
      await pipeline(response, async function* (chunks) {
        for await (const chunk of chunks) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > maxBytes) throw new PublisherError('publisher_media_too_large', 413);
          yield chunk;
        }
      }, createWriteStream(file, {flags:'wx', mode:0o600}), {signal});
      if (!bytes || (Number.isFinite(length) && length !== bytes)) throw new PublisherError('publisher_upload_mismatch', 400);
      return {bytes, mime: response.headers['content-type']?.split(';')[0]?.trim().toLowerCase()};
    } finally { response.destroy(); }
  }
  throw new PublisherError('publisher_attachment_unavailable', 502);
}
