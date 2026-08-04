import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve('painel/public/caixa.html'), 'utf8');
const css = readFileSync(resolve('painel/public/caixa.css'), 'utf8');
const scriptFiles = [
  'caixa-core.js',
  'caixa-checkout.js',
  'caixa-sales-view.js',
  'caixa-sales.js',
  'caixa-profile.js',
  'caixa.js',
];
const script = scriptFiles
  .map((file) => readFileSync(resolve('painel/public', file), 'utf8'))
  .join('\n');
const route = readFileSync(resolve('src/admin/caixa/route.ts'), 'utf8');
const staticRoute = readFileSync(resolve('src/admin/caixa/route-static.ts'), 'utf8');
const queries = readFileSync(resolve('src/admin/caixa/queries.ts'), 'utf8');
const salesQueries = readFileSync(resolve('src/admin/caixa/sales.ts'), 'utf8');
const appRoutes = readFileSync(resolve('src/app/routes.ts'), 'utf8');

describe('login mobile do Frente de Caixa da Matriz', () => {
  it('usa a identidade 2W e reproduz os elementos aprovados do PDV', () => {
    expect(html).toContain('2W PNEUS');
    expect(html).toContain('Frente de Caixa');
    expect(html).toContain('PDV MATRIZ');
    expect(html).toContain('TERMINAL 01');
    expect(html).toContain('Caixa fechado');
    expect(html).toContain('ABRIR FRENTE DE CAIXA');
    expect(html).not.toContain('Farejador');
    expect(css).toContain('.cash-status');
    expect(css).toContain('.pos-tools');
    expect(css).toContain("url('/caixa/hero-atendente-v1.webp')");
    expect(staticRoute).toContain("'/caixa/hero-atendente-v1.webp'");
    expect(staticRoute).toContain("'assets/caixa-login-atendente-v1.webp'");
    expect(staticRoute).toContain("'/caixa/catalog-tire.webp'");
    expect(staticRoute).toContain("'assets/catalog-tire.webp'");
    expect(css).toContain("url('/caixa/vendas-hero.webp')");
    expect(staticRoute).toContain("'/caixa/vendas-hero.webp'");
    expect(staticRoute).toContain("'assets/vendas-hero.webp'");
  });

  it('mantém o formulário acessível e permite escolher a persistência da sessão', () => {
    expect(html).toContain('aria-labelledby="login-heading"');
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('Manter conectado neste aparelho');
    expect(script).toContain('localStorage');
    expect(script).toContain('sessionStorage');
  });

  it('serve a porta e a API separadas do admin e da logística', () => {
    expect(staticRoute).toContain("text('/caixa', 'caixa.html'");
    scriptFiles.forEach((file) => {
      expect(html).toContain(`/caixa/${file}`);
      expect(staticRoute).toContain(`'/caixa/${file}'`);
    });
    expect(route).toContain("'/api/caixa/login'");
    expect(route).toContain("'/api/caixa/me'");
    expect(route).toContain("'/api/caixa/logout'");
    expect(route).toContain("'/api/caixa/vendas'");
    expect(route).toContain("'/api/caixa/vendas/:orderId/recibo'");
    expect(route).toContain("'/api/caixa/password'");
    expect(route).toContain('MATRIZ_CAIXA_PORTAL');
    expect(appRoutes).toContain('registerCaixaRoute');
  });

  it('entrega uma aba de vendas funcional sem usar a API administrativa', () => {
    expect(html).toContain('Vendas recentes');
    expect(html).toContain('data-period="today"');
    expect(html).toContain('data-period="7d"');
    expect(html).toContain('data-period="30d"');
    expect(html).toContain('Buscar venda ou cliente');
    expect(script).toContain("document.createTextNode('Ver recibo')");
    expect(script).toContain("tireImage.src = '/caixa/catalog-tire.webp'");
    expect(script).toContain("authenticatedFetch('/api/caixa/vendas?'");
    expect(script).toContain("'/recibo'");
    expect(script).not.toContain('/admin/api/');
    expect(salesQueries).toContain("u.slug='main'");
    expect(salesQueries).toContain("o.status<>'cancelled'");
  });

  it('entrega nova venda com catálogo, carrinho e fechamento pela API própria', () => {
    expect(html).toContain('Buscar produto, medida ou marca');
    expect(html).toContain('REVISAR E FINALIZAR');
    expect(html).toContain('data-payment="pix"');
    expect(script).toContain("authenticatedFetch('/api/caixa/catalogo?'");
    expect(script).toContain("authenticatedFetch('/api/caixa/vendas'");
    expect(script).toContain('Venda registrada, estoque baixado e Financeiro atualizado.');
    expect(route).toContain("'/api/caixa/catalogo'");
    expect(route).toContain("fastify.post('/api/caixa/vendas'");
    expect(script).not.toContain('/admin/api/');
  });

  it('reproduz o perfil completo sem conceder acesso de administrador', () => {
    expect(html).toContain('Resumo de hoje');
    expect(html).toContain('Minha conta');
    expect(html).toContain('Preferências');
    expect(html).toContain('Notificações');
    expect(html).toContain('Modo compacto');
    expect(html).toContain('Trocar senha');
    expect(html).toContain('Operador de Caixa');
    expect(html).toContain('<dd>Frente de Caixa</dd>');
    expect(html).not.toContain('<dd>Administrador</dd>');
    expect(script).toContain("authenticatedFetch('/api/caixa/password'");
    expect(script).toContain('loadProfileSummary');
  });

  it('aceita somente vendedor ativo da área de vendas e usa token próprio', () => {
    expect(queries).toContain("row.job !== 'vendedor'");
    expect(queries).toContain("row.work_area !== 'sales'");
    expect(queries).toContain("mc.job = 'vendedor' AND mc.work_area = 'sales'");
    expect(queries).toContain("const CAIXA_SESSION_PREFIX = 'cs_'");
    expect(queries).toContain('mc.revoked_at IS NULL');
  });
});
