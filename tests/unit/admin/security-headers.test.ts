import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { applySecurityHeaders } from '../../../src/app/security-headers.js';

function mockReply(): FastifyReply & { values: Record<string, string> } {
  const reply = {
    values: {} as Record<string, string>,
    header: vi.fn(function header(this: typeof reply, name: string, value: string) {
      this.values[name] = value;
      return this;
    }),
  };
  return reply as unknown as FastifyReply & { values: Record<string, string> };
}

describe('security response headers', () => {
  it('sets browser hardening headers on every environment', () => {
    const reply = mockReply();
    applySecurityHeaders(reply, false);

    expect(reply.values['Content-Security-Policy']).toContain("default-src 'self'");
    expect(reply.values['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(reply.values['X-Content-Type-Options']).toBe('nosniff');
    expect(reply.values['X-Frame-Options']).toBe('DENY');
    expect(reply.values['Referrer-Policy']).toBe('no-referrer');
    expect(reply.values['Strict-Transport-Security']).toBeUndefined();
  });

  it('enables HSTS only in production', () => {
    const reply = mockReply();
    applySecurityHeaders(reply, true);

    expect(reply.values['Strict-Transport-Security']).toContain('max-age=31536000');
  });
});
