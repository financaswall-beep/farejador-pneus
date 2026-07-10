import { createHash } from 'node:crypto';

const MAX_CONNECTIONS_PER_TOKEN = 6;
const MAX_CONNECTIONS_PER_IP = 30;

const byToken = new Map<string, number>();
const byIp = new Map<string, number>();

function tokenKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Reserva uma vaga de SSE. Retorna null quando o teto concorrente estourou. */
export function acquirePartnerSseSlot(ip: string, token: string): (() => void) | null {
  const hashedToken = tokenKey(token);
  const currentToken = byToken.get(hashedToken) ?? 0;
  const currentIp = byIp.get(ip) ?? 0;
  if (currentToken >= MAX_CONNECTIONS_PER_TOKEN || currentIp >= MAX_CONNECTIONS_PER_IP) {
    return null;
  }

  byToken.set(hashedToken, currentToken + 1);
  byIp.set(ip, currentIp + 1);
  let released = false;

  return () => {
    if (released) return;
    released = true;
    decrement(byToken, hashedToken);
    decrement(byIp, ip);
  };
}

function decrement(map: Map<string, number>, key: string): void {
  const value = map.get(key) ?? 0;
  if (value <= 1) map.delete(key);
  else map.set(key, value - 1);
}

export function __resetPartnerSseLimit(): void {
  byToken.clear();
  byIp.clear();
}
