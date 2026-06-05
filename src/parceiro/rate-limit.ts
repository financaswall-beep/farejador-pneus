/**
 * Rate-limit simples em memória pro login do Portal Parceiro — P1.
 *
 * Achado MÉDIO da revisão de segurança: /api/login era ilimitado (brute-force de
 * senha; o scrypt atenua a vazão mas não é controle). Isto é o mínimo viável:
 * janela fixa por chave (ip+slug), por instância. Não sobrevive a restart nem é
 * compartilhado entre réplicas — pra endurecer de verdade (lockout por conta,
 * contador persistente) fica no backlog. Coolify roda 1 instância hoje.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Registra uma tentativa pra `key` e diz se ESTOUROU o limite (true = bloquear).
 * Janela fixa: até `max` tentativas a cada `windowMs`.
 */
export function rateLimitHit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    maybeSweep(now);
    return false;
  }
  b.count += 1;
  return b.count > max;
}

// Limpa buckets expirados quando o Map cresce — evita vazamento de memória sob
// tráfego/IPs variados. Barato e oportunista (só quando passa do teto).
function maybeSweep(now: number): void {
  if (buckets.size < 2000) return;
  for (const [k, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(k);
  }
}

// Só pra teste: zera o estado entre casos.
export function __resetRateLimit(): void {
  buckets.clear();
}
