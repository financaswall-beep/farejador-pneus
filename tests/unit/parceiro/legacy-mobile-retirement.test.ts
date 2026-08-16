import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLegacyPartnerMobile } from '../../../src/parceiro/legacy-mobile.js';

const root = process.cwd();

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function runPartnerPanelRouting(options: { narrow: boolean; touch: boolean }) {
  const html = await source('parceiro/public/index.html');
  const inlineScript = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
  if (!inlineScript) throw new Error('script de corte mobile não encontrado');

  let redirect: string | null = null;
  const fakeWindow = {
    matchMedia: (query: string) => ({
      matches: query.includes('max-width') ? options.narrow : options.touch,
    }),
  };
  const fakeLocation = {
    pathname: '/parceiro/loja-teste/',
    replace: (value: string) => { redirect = value; },
  };
  const fakeNavigator = { maxTouchPoints: options.touch ? 1 : 0 };
  const fakeStorage = { getItem: () => 'sessao-existente' };

  new Function('window', 'location', 'navigator', 'sessionStorage', 'localStorage', inlineScript)(
    fakeWindow,
    fakeLocation,
    fakeNavigator,
    fakeStorage,
    fakeStorage,
  );
  return redirect;
}

describe('aposentadoria do mobile legado do parceiro', () => {
  it('manda celular para /operacao e preserva o painel desktop', async () => {
    await expect(runPartnerPanelRouting({ narrow: true, touch: true })).resolves.toBe('/operacao');
    await expect(runPartnerPanelRouting({ narrow: false, touch: false })).resolves.toBeNull();
  });

  it('aplica o corte também no servidor por Client Hint ou User-Agent', async () => {
    const [route, detector] = await Promise.all([
      source('src/parceiro/route.ts'),
      source('src/parceiro/legacy-mobile.ts'),
    ]);

    expect(isLegacyPartnerMobile({ 'sec-ch-ua-mobile': '?1' })).toBe(true);
    expect(isLegacyPartnerMobile({ 'sec-ch-ua-mobile': '?0', 'user-agent': 'iPhone' })).toBe(false);
    expect(isLegacyPartnerMobile({ 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS)' })).toBe(true);
    expect(isLegacyPartnerMobile({ 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe(false);

    expect(detector).toContain("headers['sec-ch-ua-mobile']");
    expect(detector).toContain('Android|iPhone|iPad|iPod');
    expect(route).toContain('isLegacyPartnerMobile(request.headers)');
    expect(route).toContain(".redirect('/operacao')");
    expect(route).toContain(".header('Vary', 'Sec-CH-UA-Mobile, User-Agent')");
  });

  it('impede novas instalações e desarma instalações PWA existentes', async () => {
    const [html, worker, route] = await Promise.all([
      source('parceiro/public/index.html'),
      source('parceiro/public/sw.js'),
      source('src/parceiro/route.ts'),
    ]);

    expect(html).not.toContain('manifest.webmanifest');
    expect(html).not.toContain('app.push.js');
    expect(worker).toContain('self.registration.unregister()');
    expect(worker).toContain("client.navigate('/operacao')");
    expect(route).not.toContain('/api/push/');
    await expect(access(path.join(root, 'parceiro/public/manifest.webmanifest'))).rejects.toThrow();
  });

  it('remove o disparador e as dependências de push do runtime', async () => {
    const [server, packageJson] = await Promise.all([
      source('src/app/server.ts'),
      source('package.json'),
    ]);

    expect(server).not.toContain('startPartnerPushFanout');
    expect(packageJson).not.toContain('web-push');
  });
});
