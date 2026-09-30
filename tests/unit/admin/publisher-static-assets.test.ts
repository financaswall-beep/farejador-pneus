import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('../../../src/shared/config/env.js',()=>({env:{NODE_ENV:'test',FAREJADOR_ENV:'test'}}));
vi.mock('../../../src/admin/auth.js',()=>({requireAdminAuth:vi.fn(),getAdminContext:vi.fn()}));
import { registerPainelStatic } from '../../../src/admin/painel/route-static.js';

it('ícones da Central usam as rotas reais de marcas e retornam SVG no roteador da aplicação',async()=>{
  const template=readFileSync('painel/public/app.marketing.publisher.view.js','utf8');
  expect(template).not.toContain('/admin/painel/assets/brands/');
  expect(template).toContain("'/assets/brands/'+destination.platform+'.svg'");
  const app=Fastify();
  await registerPainelStatic(app);
  try {
    for(const platform of ['instagram','facebook']) {
      const result=await app.inject('/assets/brands/'+platform+'.svg');
      expect(result.statusCode).toBe(200);
      expect(result.headers['content-type']).toContain('image/svg+xml');
      expect(result.body).toContain('<svg');
    }
    expect((await app.inject('/admin/painel/assets/brands/instagram.svg')).statusCode).toBe(404);
  } finally {await app.close();}
});
