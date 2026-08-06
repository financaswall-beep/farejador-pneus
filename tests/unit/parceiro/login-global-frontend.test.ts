import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function partnerFile(name: string): Promise<string> {
  return readFile(path.join(process.cwd(), 'parceiro', 'public', name), 'utf8');
}

describe('partner global login frontend', () => {
  it('keeps credential entry local and preserves the real login endpoints', async () => {
    const [html, script] = await Promise.all([
      partnerFile('login.html'),
      partnerFile('login.js'),
    ]);

    expect(html).not.toMatch(/<script[^>]+https?:\/\//i);
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('autocomplete="new-password"');
    expect(script).toContain("postJson('/api/login'");
    expect(script).toContain("postJson('/api/login/escolher'");
    expect(script).toContain("'/api/set-credentials'");
  });

  it('uses the Matriz visual family with a local optimized hero', async () => {
    const [html, css, routes, hero] = await Promise.all([
      partnerFile('login.html'),
      partnerFile('login.css'),
      readFile(path.join(process.cwd(), 'src', 'parceiro', 'login-global.route.ts'), 'utf8'),
      stat(path.join(process.cwd(), 'parceiro', 'public', 'assets', 'login-partner-hero-v1.webp')),
    ]);

    expect(html).toContain('Portal do Parceiro');
    expect(html).toContain('Sua loja conectada à');
    expect(css).toContain("url('/assets/login-partner-hero-v1.webp?v=20260806-parceiro-matriz1')");
    expect(css).toContain('--green-700: #047857');
    expect(css).toContain('@media (max-width: 850px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(routes).toContain("fastify.get('/login.css'");
    expect(routes).toContain("fastify.get('/assets/login-partner-hero-v1.webp'");
    expect(hero.size).toBeLessThan(200_000);
  });

  it('preserves login, first access and store choice states', async () => {
    const [html, script] = await Promise.all([
      partnerFile('login.html'),
      partnerFile('login.js'),
    ]);

    expect(html).toContain('id="form-login"');
    expect(html).toContain('id="form-primeiro"');
    expect(html).toContain('id="escolha"');
    expect(html).toContain('data-password-toggle="password"');
    expect(script).toContain("document.querySelectorAll('[data-password-toggle]')");
    expect(script).toContain("formPrimeiro.style.display = 'grid'");
    expect(script).toContain("tituloAcesso.textContent = 'Escolha sua loja'");
  });
});
