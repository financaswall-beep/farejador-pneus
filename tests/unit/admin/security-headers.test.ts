import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyReply } from 'fastify';
import { applySecurityHeaders, registerSecurityHeaders } from '../../../src/app/security-headers.js';

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
  it('preserves a public route CSP while retaining the global security headers', async () => {
    const server = Fastify();
    registerSecurityHeaders(server, true);
    const custom = "default-src 'none'; script-src 'self'; frame-ancestors 'none'";
    server.get('/marketing/google/contato', async (_request, reply) => reply.header('Content-Security-Policy', custom).send('contact'));
    try {
      const response = await server.inject('/marketing/google/contato');
      expect(response.headers['content-security-policy']).toBe(custom);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
    } finally { await server.close(); }
  });
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

  it('allows the exact private Storage origin for panel upload and video previews', async () => {
    const origin = 'https://publisher-project.supabase.co';
    const server = Fastify();
    registerSecurityHeaders(server, true, origin + '/');
    server.get('/admin/painel', async () => '<html></html>');
    server.get('/admin/painel/', async () => '<html></html>');
    try {
      for (const url of ['/admin/painel', '/admin/painel/', '/admin/painel?aba=marketing']) {
        const response = await server.inject({ url });
        const policy = response.headers['content-security-policy'] as string;
        const directives = policy.split('; ').map(value => value.split(' '));
        const sources = (name: string) => directives.find(value => value[0] === name)?.slice(1);
        expect(response.statusCode).toBe(200);
        expect(sources('connect-src')).toEqual([
          "'self'", origin, 'https://maps.googleapis.com', 'https://maps.gstatic.com', 'https://*.googleapis.com',
        ]);
        expect(sources('media-src')).toEqual(["'self'", 'blob:', origin]);
        expect(sources('img-src')).toContain('https:');
        expect(policy).not.toContain('https://*.supabase.co');
        expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
        expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
      }
    } finally {
      await server.close();
    }
  });

  it('keeps the existing panel policy when Storage is not configured', async () => {
    const server = Fastify();
    registerSecurityHeaders(server, false);
    server.get('/admin/painel', async () => 'panel');
    try {
      const response = await server.inject({ url: '/admin/painel' });
      const policy = response.headers['content-security-policy'] as string;
      expect(policy).toContain("connect-src 'self' https://maps.googleapis.com https://maps.gstatic.com https://*.googleapis.com;");
      expect(policy).toContain("media-src 'self' blob:;");
      expect(policy).not.toContain('supabase');
    } finally {
      await server.close();
    }
  });

  it('does not grant Storage access to login, APIs or static assets', async () => {
    const server = Fastify();
    registerSecurityHeaders(server, false, 'https://publisher-project.supabase.co');
    const paths = ['/admin/login', '/caixa', '/admin/api/marketing/publisher',
      '/admin/painel/app.js', '/admin/painel-externo'];
    paths.forEach(path => server.get(path, async () => 'ok'));
    try {
      for (const url of paths) {
        const response = await server.inject({ url });
        const expected = mockReply();
        applySecurityHeaders(expected, false);
        expect(response.headers['content-security-policy']).toBe(expected.values['Content-Security-Policy']);
        expect(response.headers['referrer-policy']).toBe('no-referrer');
      }
    } finally {
      await server.close();
    }
  });

  it('allows only the configured Storage origin for the photo upload app', async () => {
    const server=Fastify(); registerSecurityHeaders(server,false,'https://photos.supabase.co');
    server.get('/operacao',async ()=>'ok');
    try {
      const reply=await server.inject('/operacao');
      expect(reply.headers['content-security-policy']).toContain("connect-src 'self' https://photos.supabase.co;");
      expect(reply.headers['content-security-policy']).not.toContain('maps.googleapis.com');
      expect(reply.headers['referrer-policy']).toBe('no-referrer');
    } finally { await server.close(); }
  });

  it.each([
    'http://publisher-project.supabase.co',
    'https://user:password@publisher-project.supabase.co',
    'https://publisher-project.supabase.co/storage/v1',
    'https://publisher-project.supabase.co?token=secret',
    'https://publisher-project.supabase.co#fragment',
    'https://*.supabase.co',
    'https://publisher-project.supabase.co;script-src',
    'not-a-url',
  ])('rejects unsafe or non-root Storage URL %s', (url) => {
    const reply = mockReply();
    const expected = mockReply();
    applySecurityHeaders(reply, false, true, url);
    applySecurityHeaders(expected, false, true);
    expect(reply.values['Content-Security-Policy']).toBe(expected.values['Content-Security-Policy']);
  });
});
