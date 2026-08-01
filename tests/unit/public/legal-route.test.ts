import Fastify from 'fastify';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { registerPublicLegalRoutes } from '../../../src/public/legal.route.js';

const apps: ReturnType<typeof Fastify>[] = [];

async function appWithRoutes() {
  const app = Fastify();
  apps.push(app);
  await registerPublicLegalRoutes(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('páginas legais públicas da 2W Pneus', () => {
  it.each([
    ['/politica-de-privacidade', 'Política de Privacidade'],
    ['/termos-de-servico', 'Termos de Serviço'],
    ['/exclusao-de-dados', 'Exclusão de Dados'],
  ])('serve %s sem autenticação', async (url, title) => {
    const app = await appWithRoutes();
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain(title);
    expect(response.body).toContain('2W Pneus');
    expect(response.body).toContain('wallacetraderr@gmail.com');
  });

  it('serve o ícone exigido pela Meta em 1024 por 1024', async () => {
    const app = await appWithRoutes();
    const response = await app.inject({ method: 'GET', url: '/assets/2w-app-icon-1024.png' });
    const metadata = await sharp(response.rawPayload).metadata();

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(metadata.width).toBe(1024);
    expect(metadata.height).toBe(1024);
  });
});
