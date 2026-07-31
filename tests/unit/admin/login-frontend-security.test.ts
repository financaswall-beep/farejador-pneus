import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function painelFile(name: string): Promise<string> {
  return readFile(path.join(process.cwd(), 'painel', 'public', name), 'utf8');
}

describe('admin login frontend security', () => {
  it('uses same-origin cookies instead of exposing an admin bearer to panel JavaScript', async () => {
    const [api, state, fallback] = await Promise.all([
      painelFile('app.api.js'), painelFile('app.js'), painelFile('rede-fallback.js'),
    ]);
    const combined = api + state + fallback;

    expect(combined).not.toContain('ADMIN_AUTH_TOKEN para carregar');
    expect(combined).not.toContain('Authorization: `Bearer ${this.apiToken}`');
    expect(combined).not.toContain("sessionStorage.setItem('farejador_admin_token'");
    expect(api).toContain("fetch('/admin/api/auth/me'");
    expect(api).toContain("credentials: 'same-origin'");
  });

  it('loads no third-party JavaScript on the credential-entry page', async () => {
    const html = await painelFile('login.html');

    expect(html).not.toMatch(/<script[^>]+https?:\/\//i);
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('autocomplete="new-password"');
  });

  it('never stores the emergency token during owner bootstrap', async () => {
    const script = await painelFile('login.js');

    expect(script).not.toContain('localStorage');
    expect(script).not.toContain('sessionStorage');
    expect(script).toContain("Authorization: `Bearer ${data.get('token')}`");
  });

  it('renders the Matriz visual with a local optimized asset and responsive fallback', async () => {
    const [html, css, routes, hero] = await Promise.all([
      painelFile('login.html'),
      painelFile('login.css'),
      readFile(path.join(process.cwd(), 'src', 'admin', 'painel', 'route-static.ts'), 'utf8'),
      stat(path.join(process.cwd(), 'painel', 'public', 'assets', 'login-matriz-hero-v1.webp')),
    ]);

    expect(html).toContain('A gestão que move');
    expect(html).toContain('data-password-toggle="password"');
    expect(html).toContain('id="bootstrap-form"');
    expect(css).toContain("url('/admin/login/hero-v1.webp?v=20260731-matriz-login1')");
    expect(css).toContain('@media (max-width: 850px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(routes).toContain("fastify.get('/admin/login/hero-v1.webp'");
    expect(hero.size).toBeLessThan(200_000);
  });

  it('keeps password visibility local and submits through the real form button', async () => {
    const script = await painelFile('login.js');

    expect(script).toContain("document.querySelectorAll('[data-password-toggle]')");
    expect(script).toContain("input.type = visible ? 'password' : 'text'");
    expect(script).toContain("loginForm.querySelector('button[type=\"submit\"]')");
    expect(script).toContain("bootstrapForm.querySelector('button[type=\"submit\"]')");
  });
});
