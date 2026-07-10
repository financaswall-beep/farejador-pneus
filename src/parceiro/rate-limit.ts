// Compatibilidade: testes e scripts antigos ainda importam este caminho.
export {
  rateLimitHit,
  rateLimitBlocked,
  rateLimitClear,
  rateLimitRetryAfterSeconds,
  __resetRateLimit,
} from '../shared/rate-limit.js';
