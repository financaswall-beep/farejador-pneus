import { beforeEach, describe, expect, it } from 'vitest';
import { acquirePartnerSseSlot, __resetPartnerSseLimit } from '../../../src/parceiro/sse-limit.js';

describe('partner SSE concurrent limit', () => {
  beforeEach(() => __resetPartnerSseLimit());

  it('allows six connections per identity and rejects the seventh', () => {
    const releases = Array.from({ length: 6 }, () => acquirePartnerSseSlot('203.0.113.4', 'token-id'));

    expect(releases.every(Boolean)).toBe(true);
    expect(acquirePartnerSseSlot('203.0.113.5', 'token-id')).toBeNull();
  });

  it('frees the slot exactly once when a stream closes', () => {
    const releases = Array.from({ length: 6 }, () => acquirePartnerSseSlot('203.0.113.4', 'token-id'));
    const release = releases[0];
    expect(release).not.toBeNull();

    release?.();
    release?.();

    expect(acquirePartnerSseSlot('203.0.113.5', 'token-id')).not.toBeNull();
  });
});
