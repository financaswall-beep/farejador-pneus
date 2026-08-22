import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve('painel/public/caixa.html'), 'utf8');
const css = readFileSync(resolve('painel/public/caixa.css'), 'utf8');
const scriptFiles = [
  'caixa-core.js',
  'caixa-modules.js',
  'caixa-checkout-catalog.js',
  'caixa-checkout-pricing.js',
  'caixa-checkout.js',
  'caixa-checkout-session.js',
  'caixa-sales-weekly.js',
  'caixa-sales-view.js',
  'caixa-stock-view.js',
  'caixa-stock-detail.js',
  'caixa-stock-price.js',
  'caixa-stock-edit.js',
  'caixa-stock.js',
  'caixa-stock-count.js',
  'caixa-sales.js',
  'caixa-deliveries-matrix.js',
  'caixa-deliveries.js',
  'caixa-finance.js',
  'caixa-finance-entries.js',
  'caixa-finance-commissions.js',
  'caixa-finance-commission-detail.js',
  'caixa-team.js',
  'caixa-team-remuneration.js',
  'caixa-team-commission.js',
  'caixa-team-permissions.js',
  'caixa-profile.js',
  'caixa-photo.js',
  'caixa.js',
];
const script = scriptFiles
  .map((file) => readFileSync(resolve('painel/public', file), 'utf8'))
  .join('\n');
const route = [
  'src/admin/caixa/route.ts',
  'src/admin/caixa/route-commissions.ts',
  'src/admin/caixa/route-team.ts',
  'src/admin/caixa/route-operation-login.ts',
].map((file) => readFileSync(resolve(file), 'utf8')).join('\n');
const photoRoute = readFileSync(resolve('src/admin/caixa/route-photo.ts'), 'utf8');
const staticRoute = readFileSync(resolve('src/admin/caixa/route-static.ts'), 'utf8');
const queries = readFileSync(resolve('src/admin/caixa/queries.ts'), 'utf8');
const salesQueries = readFileSync(resolve('src/admin/caixa/my-sales.ts'), 'utf8');
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
    expect(html).not.toContain('modo=painel');
    expect(html).not.toContain('Sou administrador da loja');
    expect(html).toContain('Vendas');
    expect(html).toContain('Estoque');
    expect(html).toContain('Entregas');
    expect(html).not.toContain('Farejador');
    expect(css).toContain('.cash-status');
    expect(css).toContain('.operation-modules');
    expect(css).toContain("url('/operacao/hero-atendente-v1.webp')");
    expect(staticRoute).toContain("'/operacao/hero-atendente-v1.webp'");
    expect(staticRoute).toContain("'assets/caixa-login-atendente-v1.webp'");
    expect(staticRoute).toContain("'/operacao/catalog-tire.webp'");
    expect(staticRoute).toContain("'assets/catalog-tire.webp'");
    expect(css).toContain("url('/operacao/vendas-hero.webp')");
    expect(staticRoute).toContain("'/operacao/vendas-hero.webp'");
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
    expect(staticRoute).toContain("text('/operacao', 'caixa.html'");
    expect(staticRoute).toContain("['/caixa', '/caixa/', '/vendas', '/caixa/vendas']");
    expect(staticRoute).toContain("redirect('/operacao#vendas')");
    expect(staticRoute).toContain("['/entregas', '/entregas/']");
    expect(staticRoute).toContain("redirect('/operacao#entregas')");
    expect(script).toContain("window.location.hash === '#vendas'");
    scriptFiles.forEach((file) => {
      expect(html).toContain(`/operacao/${file}`);
      expect(staticRoute).toContain(`'/operacao/${file}'`);
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
    expect(appRoutes).not.toContain('registerEntregadorRoute');
  });

  it('resolve Matriz ou parceira no servidor e mostra escolha só para vários vínculos', () => {
    expect(html).toContain('id="workplace-chooser"');
    expect(html).toContain('Onde você vai trabalhar agora?');
    expect(script).toContain("payload.mode === 'choose'");
    expect(script).toContain("payload.scope === 'partner'");
    expect(script).toContain("fetch('/api/caixa/login/escolher'");
    expect(script).toContain("'farejador_partner_token_' + payload.slug");
    expect(script).toContain("Caixa.operationPath('me', '/api/caixa/me')");
    expect(route).toContain('authenticateOperation');
    expect(route).toContain('newOperationLoginTicket');
    expect(route).toContain('publicOperationWorkplace');
    expect(queries).toContain('mintCaixaSessionForPerson');
  });

  it('atualiza o menu com as permissões atuais devolvidas pelo servidor', () => {
    expect(script).toContain('Caixa.syncSessionMetadata(data)');
    expect(script).toContain('const effective = data.modules || (data.permissions ?');
    expect(script).toContain('storage.setItem(keys.modules, JSON.stringify(effective))');
    expect(script).toContain("setNavigationVisibility('nav-finance', canModule('financeiro'))");
    expect(script).toContain('authorizedOperationTab: authorizedOperationTab');
    expect(script).toContain('tab = Caixa.authorizedOperationTab ? Caixa.authorizedOperationTab(tab) : tab');
    expect(script).toContain("'finance-commission-detail': 'financeiro'");
    expect(script).toContain("'team-permissions': 'team'");
  });

  it('entrega uma aba de vendas funcional sem usar a API administrativa', () => {
    expect(html).toContain('Minhas vendas recentes');
    expect(html).toContain('Somente suas vendas');
    expect(html).toContain('id="weekly-commission"');
    expect(html).not.toContain('data-period=');
    expect(html).not.toContain('class="sales-metrics"');
    expect(html).not.toContain('Buscar venda ou cliente');
    expect(script).toContain("document.createTextNode('Ver detalhes')");
    expect(script).toContain("item.image_url || '/operacao/catalog-tire.webp'");
    expect(script).toContain("Caixa.operationPath('minhas-vendas', '/api/caixa/vendas')");
    expect(script).toContain("'/recibo'");
    expect(script).not.toContain('/admin/api/');
    expect(salesQueries).toContain("u.slug='main'");
    expect(salesQueries).toContain("o.status IN ('confirmed','paid','delivered')");
    expect(html).toContain('id="weekly-summary"');
    expect(html).toContain('id="weekly-bars"');
    expect(html).toContain('id="weekly-prev"');
    expect(html).toContain('id="weekly-next"');
    expect(html).toContain('Itens vendidos');
    expect(html).toContain('Minha comissão');
    expect(script).toContain('payload.daily_series');
    expect(script).toContain("new URLSearchParams({ week: String(state.weekOffset) })");
    expect(script).toContain('state.selectedSalesDay = null');
    expect(html).toContain('id="weekly-grid"');
    expect(html).toContain('id="weekly-clear-day"');
    expect(script).not.toContain('periodButtons');
    expect(script).toContain('selectSalesDay');
    expect(script).toContain('item.dataset.salesDay = day.date');
    expect(script).toContain("localDateKey(sale.created_at) === Caixa.state.selectedSalesDay");
    expect(css).toContain('.weekly-reference');
    expect(css).toContain('.weekly-bar-item.is-selected');
    expect(route).toContain('week: z.coerce.number().int().min(-52).max(0)');
  });

  it('toca e abre a fila de fotos da Matriz em tempo real', () => {
    expect(html).toContain('id="photo-alert"');
    expect(html).toContain('id="photo-modal"');
    expect(script).toContain("new Audio('/operacao/som-pedido-novo.mp3')");
    expect(script).toContain("new EventSource('/api/caixa/photo-stream?ticket='");
    expect(script).toContain("data.kind === 'photo_request'");
    expect(script).toContain("capture = 'environment'");
    expect(script).toContain("'/photo'");
    expect(photoRoute).toContain("'/api/caixa/photo-requests'");
    expect(photoRoute).toContain("'/api/caixa/photo-stream-ticket'");
    expect(photoRoute).toContain("'/api/caixa/photo-stream'");
    expect(staticRoute).toContain("'/operacao/som-pedido-novo.mp3'");
    expect(staticRoute).toContain("'som-pedido-novo.mp3'");
  });

  it('entrega nova venda com catálogo, carrinho e fechamento pela API própria', () => {
    expect(html).toContain('Buscar produto, medida ou marca');
    expect(html).toContain('FINALIZAR VENDA');
    expect(html).toContain('data-payment="pix"');
    expect(html).toContain('data-catalog-type="other"');
    expect(html).toContain('id="operation-unit-label"');
    expect(html).toContain('<span>Caixa</span>');
    expect(html).toContain('id="nav-stock"');
    expect(html).toContain('id="nav-deliveries"');
    expect(script).toContain("Caixa.operationPath('produtos')");
    expect(script).toContain("Caixa.operationPath('vendas', '/api/caixa/vendas')");
    expect(script).toContain("partner_stock_id: line.product.partner_stock_id");
    expect(script).toContain("source_tag: 'walkin_balcao'");
    expect(script).toContain('Venda registrada, estoque baixado e financeiro atualizado.');
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

  it('entrega o Financeiro simples somente por modulo autorizado', () => {
    expect(html).toContain('id="finance-panel"');
    expect(html).toContain('id="nav-finance"');
    expect(html).toContain('Resumo do mês');
    expect(html).toContain('Pendências');
    expect(html).toContain('Comissões');
    expect(html).not.toContain('Ver financeiro completo');
    expect(html).toContain('id="finance-entries-panel"');
    expect(html).toContain('id="finance-entries-range"');
    expect(html).toContain('Entrou no período');
    expect(html).toContain('<option value="today">Hoje</option>');
    expect(html).toContain('<option value="7d">7 dias</option>');
    expect(html).toContain('<option value="15d">15 dias</option>');
    expect(html).toContain('<option value="30d" selected>1 mês</option>');
    expect(css).toContain('.finance-hero');
    expect(css).toContain("url('/operacao/finance-hero.webp')");
    expect(css).toContain("url('/operacao/finance-shell-positive-v3.webp')");
    expect(css).toContain("url('/operacao/finance-shell-negative-v3.webp')");
    expect(staticRoute).toContain("'/operacao/finance-hero.webp'");
    expect(staticRoute).toContain("'/operacao/finance-shell-positive-v2.webp'");
    expect(staticRoute).toContain("'/operacao/finance-shell-negative-v2.webp'");
    expect(staticRoute).toContain("'/operacao/finance-shell-positive-v3.webp'");
    expect(staticRoute).toContain("'/operacao/finance-shell-negative-v3.webp'");
    expect(script).toContain("Caixa.canModule('financeiro')");
    expect(script).toContain("Caixa.operationPath('financeiro-simples'");
    const movements = readFileSync(resolve('painel/public/caixa-finance-entries.js'), 'utf8');
    expect(movements).toContain("resource: 'financeiro-entradas'");
    expect(movements).toContain("resource: 'financeiro-saidas'");
    expect(movements).toContain('Caixa.operationPath(mode.resource, mode.matrixPath)');
    expect(movements).toContain("hash: '#financeiro/saidas'");
    expect(css).toContain('.finance-entries-page.is-output');
    expect(script).toContain("'?range=' + encodeURIComponent(range)");
    expect(script).toContain("window.location.hash === '#financeiro'");
    expect(route).toContain("'/api/caixa/financeiro-simples'");
    expect(route).toContain("'/api/caixa/financeiro-entradas'");
    expect(route).toContain("'/api/caixa/financeiro-saidas'");
    expect(route).toContain("'/api/caixa/financeiro-comissoes'");
    expect(route).toContain("'/api/caixa/financeiro-comissoes/:collaboratorId'");
    expect(html).toContain('id="finance-commissions-panel"');
    expect(html).toContain('id="finance-commission-detail-panel"');
    expect(html).toContain('id="finance-commission-detail-rules"');
    expect(html).toContain('<small>Financeiro</small><h2 id="finance-commissions-title">Comissões</h2>');
    expect(html).toContain('<small>Financeiro</small><h2 id="finance-commission-detail-title">Detalhes da comissão</h2>');
    expect(html).not.toContain('<span>Proprietário</span>');
    expect(script).toContain("Caixa.operationPath('financeiro-comissoes'");
    expect(script).toContain("window.location.hash = '#financeiro/comissoes'");
    expect(script).toContain("return 'Por tipo de item'");
    expect(script).toContain('commission_item_rules');
    expect(css).toContain('.finance-commission-list');
    expect(route).toContain("requireCaixaModule('financeiro')");
    expect(route).toContain("z.enum(['today', '7d', '15d', '30d'])");
  });

  it('entrega a Equipe somente ao proprietário e reaproveita a interface na Matriz e no parceiro', () => {
    expect(html).toContain('id="team-panel"');
    expect(html).toContain('id="team-remuneration-panel"');
    expect(html).toContain('id="team-commission-panel"');
    expect(html).toContain('id="team-commission-tire-kind"');
    expect(html).toContain('Valor fixo por pneu');
    expect(html).toContain('id="team-commission-service-kind"');
    expect(html).not.toContain('aria-label="Aplicação da regra atual"');
    expect(html).toContain('id="team-permissions-panel"');
    expect(html).toContain('id="nav-team"');
    expect(html).toContain('Novo colaborador');
    expect(html).toContain('id="team-title" class="sr-only">Equipe');
    expect(html).toContain('class="team-detail-heading"');
    expect(html).not.toContain('class="team-toolbar');
    expect(html).not.toContain('id="team-title">Colaboradores');
    expect(html).toContain('id="team-create-modal"');
    expect(html).toContain('id="team-create-form"');
    expect(html).toContain('id="team-inactive-toggle"');
    expect(html).toContain('id="team-open-finance-commission"');
    expect(html).toContain('sem acesso de proprietário');
    expect(html).toContain('Salvar remuneração');
    expect(html).toContain('name="team-salary-frequency" value="weekly"');
    expect(html).toContain('Valor exato da semana; fecha sábado');
    expect(script).toContain('salary_frequency: salaryFrequency()');
    expect(script).toContain('benefícios continuam mensais');
    expect(html).toContain('Salvar regra de comissão');
    expect(html).toContain('Salvar permissões');
    expect(script).not.toContain('Bate-papo');
    expect(script).toContain("Caixa.stored(Caixa.keys.role) === 'owner'");
    expect(script).toContain("Caixa.operationPath('equipe', '/api/caixa/equipe')");
    expect(script).toContain("window.location.hash = '#equipe'");
    expect(script).toContain("openMember(member, 'permissoes')");
    expect(script).not.toContain("'/admin/#colaboradores'");
    expect(route).toContain("'/api/caixa/equipe'");
    expect(route).toContain("fastify.post('/api/caixa/equipe'");
    expect(route).toContain("'/api/caixa/equipe/:collaboratorId/remuneracao'");
    expect(route).toContain("'/api/caixa/equipe/:collaboratorId/comissao'");
    expect(route).toContain("'/api/caixa/equipe/:collaboratorId/permissoes'");
    expect(route).toContain("error: 'owner_required'");
    expect(css).toContain('.team-member-card');
    expect(css).toContain('.team-rule-options');
    expect(css).toContain('.team-permission-row');
  });

  it('aceita somente vendedor ativo da área de vendas e usa token próprio', () => {
    expect(queries).toContain("row.job !== 'vendedor'");
    expect(queries).toContain("row.work_area !== 'sales'");
    expect(queries).toContain("mc.job = 'vendedor' AND mc.work_area = 'sales'");
    expect(queries).toContain("const CAIXA_SESSION_PREFIX = 'cs_'");
    expect(queries).toContain('mc.revoked_at IS NULL');
  });
});
