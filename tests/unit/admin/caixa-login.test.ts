import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve('painel/public/caixa.html'), 'utf8');
const css = readFileSync(resolve('painel/public/caixa.css'), 'utf8');
const scriptFiles = [
  'caixa-core.js',
  'caixa-checkout-catalog.js',
  'caixa-checkout.js',
  'caixa-sales-view.js',
  'caixa-sales.js',
  'caixa-profile.js',
  'caixa-photo.js',
  'caixa.js',
];
const script = scriptFiles
  .map((file) => readFileSync(resolve('painel/public', file), 'utf8'))
  .join('\n');
const route = [
  'src/admin/caixa/route.ts',
  'src/admin/caixa/route-operation-login.ts',
].map((file) => readFileSync(resolve(file), 'utf8')).join('\n');
const photoRoute = readFileSync(resolve('src/admin/caixa/route-photo.ts'), 'utf8');
const staticRoute = readFileSync(resolve('src/admin/caixa/route-static.ts'), 'utf8');
const queries = readFileSync(resolve('src/admin/caixa/queries.ts'), 'utf8');
const salesQueries = readFileSync(resolve('src/admin/caixa/sales.ts'), 'utf8');
const appRoutes = readFileSync(resolve('src/app/routes.ts'), 'utf8');

describe('login mobile da Operação da Loja', () => {
  it('preserva a identidade 2W e apresenta os três módulos operacionais', () => {
    expect(html).toContain('2W PNEUS');
    expect(html).toContain('Operação da Loja');
    expect(html).toContain('Venda, estoque e entregas em um só lugar');
    expect(html).toContain('Pronto para começar');
    expect(html).toContain('Seu acesso e sua unidade serão identificados pelo login');
    expect(html).toContain('ENTRAR NA OPERAÇÃO');
    expect(html).toContain('Cada funcionário entra com sua própria conta.');
    expect(html).toContain('Vendas');
    expect(html).toContain('Estoque');
    expect(html).toContain('Entregas');
    expect(html).not.toContain('Farejador');
    expect(css).toContain('.cash-status');
    expect(css).toContain('.operation-modules');
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
    expect(staticRoute).toContain("['/vendas', '/caixa/vendas']");
    expect(staticRoute).toContain("redirect('/caixa#vendas')");
    expect(script).toContain("window.location.hash === '#vendas'");
    scriptFiles.forEach((file) => {
      expect(html).toContain(`/caixa/${file}`);
      expect(staticRoute).toContain(`'/caixa/${file}'`);
    });
    expect(route).toContain("'/api/caixa/login'");
    expect(route).toContain("'/api/caixa/login/escolher'");
    expect(route).toContain("'/api/caixa/me'");
    expect(route).toContain("'/api/caixa/logout'");
    expect(route).toContain("'/api/caixa/vendas'");
    expect(route).toContain("'/api/caixa/vendas/:orderId/recibo'");
    expect(route).toContain("'/api/caixa/password'");
    expect(route).toContain('MATRIZ_CAIXA_PORTAL');
    expect(route).toContain('OPERACAO_LOJA_PORTAL');
    expect(appRoutes).toContain('registerCaixaRoute');
  });

  it('resolve Matriz ou parceira no servidor e mostra escolha só para vários vínculos', () => {
    expect(html).toContain('id="workplace-chooser"');
    expect(html).toContain('Onde você vai trabalhar agora?');
    expect(script).toContain("payload.mode === 'choose'");
    expect(script).toContain("payload.scope === 'partner'");
    expect(script).toContain("fetch('/api/caixa/login/escolher'");
    expect(script).toContain("'farejador_partner_token_' + payload.slug");
    expect(route).toContain('authenticateOperation');
    expect(route).toContain('newOperationLoginTicket');
    expect(route).toContain('publicOperationWorkplace');
    expect(queries).toContain('mintCaixaSessionForPerson');
  });

  it('entrega uma aba de vendas funcional sem usar a API administrativa', () => {
    expect(html).toContain('Vendas recentes');
    expect(html).not.toContain('data-period=');
    expect(html).not.toContain('class="sales-metrics"');
    expect(html).toContain('Buscar venda ou cliente');
    expect(script).toContain("document.createTextNode('Ver recibo')");
    expect(script).toContain("tireImage.src = '/caixa/catalog-tire.webp'");
    expect(script).toContain("authenticatedFetch('/api/caixa/vendas?'");
    expect(script).toContain("'/recibo'");
    expect(script).not.toContain('/admin/api/');
    expect(salesQueries).toContain("u.slug='main'");
    expect(salesQueries).toContain("o.status<>'cancelled'");
    expect(html).toContain('id="weekly-summary"');
    expect(html).toContain('id="weekly-bars"');
    expect(html).toContain('id="weekly-prev"');
    expect(html).toContain('id="weekly-next"');
    expect(html).toContain('id="weekly-detail-period"');
    expect(html).toContain('Itens vendidos');
    expect(html).toContain('Faturamento total');
    expect(script).toContain('payload.daily_series');
    expect(script).toContain("new URLSearchParams({ period: '7d', week: String(state.weekOffset) })");
    expect(script).not.toContain('periodButtons');
    expect(script).toContain("item.setAttribute('aria-pressed'");
    expect(script).toContain('selectWeeklyDay');
    expect(css).toContain('.weekly-reference');
    expect(css).toContain('.weekly-bar-item.is-selected');
    expect(route).toContain('week: z.coerce.number().int().min(-52).max(0)');
  });

  it('toca e abre a fila de fotos da Matriz em tempo real', () => {
    expect(html).toContain('id="photo-alert"');
    expect(html).toContain('id="photo-modal"');
    expect(script).toContain("new Audio('/caixa/som-pedido-novo.mp3')");
    expect(script).toContain("new EventSource('/api/caixa/photo-stream?ticket='");
    expect(script).toContain("data.kind === 'photo_request'");
    expect(script).toContain("capture = 'environment'");
    expect(script).toContain("'/photo'");
    expect(photoRoute).toContain("'/api/caixa/photo-requests'");
    expect(photoRoute).toContain("'/api/caixa/photo-stream-ticket'");
    expect(photoRoute).toContain("'/api/caixa/photo-stream'");
    expect(staticRoute).toContain("'/caixa/som-pedido-novo.mp3'");
    expect(staticRoute).toContain("'som-pedido-novo.mp3'");
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
