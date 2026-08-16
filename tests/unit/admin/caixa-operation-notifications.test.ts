import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync('painel/public/caixa.html', 'utf8');
const css = readFileSync('painel/public/caixa.css', 'utf8');
const modules = readFileSync('painel/public/caixa-modules.js', 'utf8');
const notifications = readFileSync('painel/public/caixa-notifications.js', 'utf8');
const partnerRoutes = readFileSync('src/parceiro/route-operation-notifications.ts', 'utf8');
const appRoutes = readFileSync('src/app/routes.ts', 'utf8');
const matrixRoutes = readFileSync('src/admin/caixa/route-notifications.ts', 'utf8');

describe('central de notificações da Operação da Loja', () => {
  it('separa pedidos de foto dos avisos internos', () => {
    expect(html).toContain('id="notifications-button"');
    expect(html).toContain('id="notifications-panel"');
    expect(html).toContain('data-notification-tab="photo"');
    expect(html).toContain('data-notification-tab="system"');
    expect(html).toContain('/operacao/caixa-notifications.js?v=20260816-notifications1');
  });

  it('mantém os atalhos no tamanho legível e permite rolagem horizontal', () => {
    expect(css).toMatch(/\.bottom-nav\s*\{[^}]*display:\s*flex[^}]*overflow-x:\s*auto/s);
    expect(css).toMatch(/\.bottom-nav button\s*\{[^}]*flex:\s*0 0 78px/s);
    expect(modules).not.toContain('gridTemplateColumns =');
  });

  it('usa os endpoints próprios de Matriz e parceiro', () => {
    expect(notifications).toContain("'/api/caixa/notificacoes'");
    expect(notifications).toContain("Caixa.operationPath('operacao/notificacoes')");
    expect(matrixRoutes).toContain("fastify.get('/api/caixa/notificacoes'");
    expect(partnerRoutes).toContain("fastify.get('/parceiro/:slug/api/operacao/notificacoes'");
    expect(appRoutes).toContain('registerPartnerOperationNotificationRoutes(fastify)');
  });

  it('protege foto por permissão de vendas e calcula avisos no servidor', () => {
    expect(partnerRoutes).toContain("requireScreen('vendas')");
    expect(partnerRoutes).toContain('resolvePartnerPermissions(ctx)');
    expect(partnerRoutes).toContain('getPartnerOperationNotifications(ctx, permissions)');
  });
});
