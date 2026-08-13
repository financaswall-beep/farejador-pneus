import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function partnerFile(name: string): Promise<string> {
  return readFile(path.join(process.cwd(), 'parceiro', 'public', name), 'utf8');
}

async function runLoginRouting(options: {
  search?: string;
  narrow: boolean;
  touch: boolean;
}): Promise<{ redirect: string | null; classes: string[] }> {
  const html = await partnerFile('login.html');
  const inlineScript = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
  if (!inlineScript) throw new Error('script de roteamento do login não encontrado');

  const classes: string[] = [];
  let redirect: string | null = null;
  const fakeWindow = {
    location: {
      search: options.search ?? '',
      replace: (value: string) => { redirect = value; },
    },
    matchMedia: (query: string) => ({
      matches: query.includes('max-width') ? options.narrow : options.touch,
    }),
  };
  const fakeDocument = {
    documentElement: { classList: { add: (value: string) => classes.push(value) } },
  };
  const fakeNavigator = { maxTouchPoints: options.touch ? 1 : 0 };

  new Function('window', 'document', 'navigator', inlineScript)(
    fakeWindow,
    fakeDocument,
    fakeNavigator,
  );
  return { redirect, classes };
}

describe('partner global login frontend', () => {
  it('keeps credential entry local and preserves the real login endpoints', async () => {
    const [html, script] = await Promise.all([
      partnerFile('login.html'),
      partnerFile('login.js'),
    ]);

    expect(html).not.toMatch(/<script[^>]+https?:\/\//i);
    expect(html).toContain("params.get('modo') === 'painel'");
    expect(html).toContain("document.documentElement.classList.add('panel-mobile-override')");
    expect(html).toContain("window.matchMedia('(max-width: 768px)')");
    expect(html).toContain("window.location.replace('/operacao')");
    expect(html).toContain('Sou funcionário — acessar Operação da Loja');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('autocomplete="new-password"');
    expect(script).toContain("postJson('/api/login'");
    expect(script).toContain("postJson('/api/login/escolher'");
    expect(script).toContain("'/api/set-credentials'");
  });

  it('leva o celular para a Operação da Loja e preserva o login web no computador', async () => {
    await expect(runLoginRouting({ narrow: true, touch: true })).resolves.toEqual({
      redirect: '/operacao',
      classes: [],
    });
    await expect(runLoginRouting({ narrow: false, touch: false })).resolves.toEqual({
      redirect: null,
      classes: [],
    });
  });

  it('mantém o acesso administrativo explícito no celular sem ressuscitar o layout antigo', async () => {
    await expect(runLoginRouting({
      search: '?modo=painel',
      narrow: true,
      touch: true,
    })).resolves.toEqual({
      redirect: null,
      classes: ['panel-mobile-override'],
    });
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
    expect(css).toContain("url('/assets/login-partner-hero-v1.webp?v=20260806-parceiro-mobile2')");
    expect(css).toContain('--green-700: #047857');
    expect(css).not.toContain("url('/assets/login-2w-mobile");
    expect(css).not.toContain('@media (max-width: 500px)');
    expect(css).toContain('html.panel-mobile-override .auth-region');
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
    expect(script).toContain("document.body.classList.add('first-access-active')");
    expect(script).toContain("tituloAcesso.textContent = 'Escolha sua loja'");
  });
});
