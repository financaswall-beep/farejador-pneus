import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('login mobile do entregador', () => {
  it('usa a arte vertical da Fiorino 2W e mantém o formulário acessível', () => {
    const html = readFileSync(resolve('painel/public/entregas.html'), 'utf8');
    const route = readFileSync(resolve('src/admin/entregador/route.ts'), 'utf8');
    const asset = resolve('painel/public/assets/entregas-login-fiorino-galpao-v5.webp');

    expect(statSync(asset).size).toBeGreaterThan(50_000);
    expect(html).toContain("url('/entregas/hero-fiorino-galpao-v5.webp')");
    expect(html).toContain('aria-labelledby="delivery-login-title"');
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('autocomplete="current-password"');
    expect(route).toContain("fastify.get('/entregas/hero-fiorino-galpao-v5.webp'");
    expect(route).toContain("'assets/entregas-login-fiorino-galpao-v5.webp'");
  });
});
