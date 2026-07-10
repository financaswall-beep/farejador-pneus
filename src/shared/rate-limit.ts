/** Rate-limit de janela fixa compartilhado pelos pontos de entrada HTTP. */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function activeBucket(key: string, now = Date.now()): Bucket | null {
  const bucket = buckets.get(key);
  if (!bucket) return null;
  if (now >= bucket.resetAt) {
    buckets.delete(key);
    return null;
  }
  return bucket;
}

/** Registra uma tentativa. `true` significa que ela ultrapassou o limite. */
export function rateLimitHit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = activeBucket(key, now);
  if (!bucket) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    maybeSweep(now);
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}

/** Consulta sem consumir tentativa. */
export function rateLimitBlocked(key: string, max: number): boolean {
  const bucket = activeBucket(key);
  return bucket !== null && bucket.count >= max;
}

export function rateLimitClear(key: string): void {
  buckets.delete(key);
}

export function rateLimitRetryAfterSeconds(key: string): number {
  const bucket = activeBucket(key);
  if (!bucket) return 0;
  return Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000));
}

function maybeSweep(now: number): void {
  if (buckets.size < 2000) return;
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}

export function __resetRateLimit(): void {
  buckets.clear();
}
