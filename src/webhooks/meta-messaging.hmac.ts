import { createHmac, timingSafeEqual } from 'node:crypto';

function safeHexEqual(expected: string, provided: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
}

export function validateMetaMessagingSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeHexEqual(expected, signatureHeader.slice('sha256='.length));
}

export function verifyTokenMatches(provided: string, expected: string): boolean {
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
