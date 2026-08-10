import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function partnerFile(name: string): Promise<string> {
  return readFile(path.join(process.cwd(), 'parceiro', 'public', name), 'utf8');
}

describe('partner mobile summary', () => {
  it('activates the new composition on mobile for whoever has Resumo permission', async () => {
    const html = await partnerFile('index.html');
    const mobileSummary = html.split('<!-- RESUMO MOBILE:')[1]
      ?.split('<nav x-show="currentSection === \'resumo\'"')[0] ?? '';

    expect(html).toContain("currentSection === 'resumo' && 'summary-screen'");
    expect(mobileSummary).toContain("currentSection === 'resumo' && isMobile && canSee('resumo')");
    expect(mobileSummary).toContain('class="mobile-summary-owner"');
    expect(mobileSummary).not.toContain('Nova venda');
    expect(html).toContain("currentSection === 'resumo' && !isMobile");
    expect(html).not.toContain("currentSection === 'resumo' && (!isMobile || !isOwner)");
  });

  it('binds the cards to existing real operational data', async () => {
    const html = await partnerFile('index.html');

    expect(html).toContain('money(resumo?.sales_month)');
    expect(html).toContain('money(commissionTeam?.total_commission)');
    expect(html).toContain("stockTotalUnits + ' un.'");
    expect(html).toContain('money(resumo?.open_receivables_total)');
    expect(html).toContain('money(resumo?.cash_in_month)');
    expect(html).toContain('money(resumo?.cash_out_month)');
    expect(html).toContain('money(resumo?.cash_net_month)');
    expect(html).toContain('deliveryOpenCount');
    expect(html).toContain('mobileSummaryPayablesDueTodayCount');
    expect(html).toContain('x-show="canSee(\'estoque\')" @click="goToSection(\'estoque\')"');
    expect(html).toContain('x-show="canSee(\'entrega\')" @click="goToSection(\'entrega\')"');
    expect(html).toContain('x-show="canSee(\'financeiro\')" @click="goToSection(\'financeiro\')"');
    expect(html).toContain('x-show="isOwner" @click="openMobileSummaryTeam()"');
  });

  it('loads team ranking through the same Resumo permission on UI and backend', async () => {
    const [core, commission, route] = await Promise.all([
      partnerFile('app.core.js'),
      partnerFile('app.comissao.js'),
      readFile(path.join(process.cwd(), 'src', 'parceiro', 'route.ts'), 'utf8'),
    ]);

    expect(core).toContain("if (this.canSee('resumo')) {");
    expect(core).toContain('await this.loadCommissionTeam()');
    expect(commission).toContain("if (!this.canSee('resumo')) return;");
    expect(route).toContain("/parceiro/:slug/api/comissao/equipe', { preHandler: [requirePartnerAuth, requireScreen('resumo')] }");
  });

  it('ranks up to three employees by finalized monthly gross sales', async () => {
    const resumo = await partnerFile('app.resumo.js');

    expect(resumo).toContain('get mobileSummaryTeam()');
    expect(resumo).toContain('this.num(b?.gross_sales) - this.num(a?.gross_sales)');
    expect(resumo).toContain('.slice(0, 3)');
    expect(resumo).toContain("item?.status === 'open'");
    expect(resumo).toContain("this.dateKeySaoPaulo(new Date())");
  });

  it('supports collaborator photos with a neutral fallback and an isolated mobile shell', async () => {
    const [html, css] = await Promise.all([
      partnerFile('index.html'),
      partnerFile('style.css'),
    ]);

    expect(html).toContain('class="mobile-summary-avatar"');
    expect(html).toContain('x-show="member.avatar_url"');
    expect(html).toContain('data-lucide="user-round"');
    expect(html).toContain('class="pos-summary-mobile-nav"');
    expect(css).toContain('RESUMO MOBILE POR PERMISSÃO 2026-08-10');
    expect(css).toContain('@media (max-width: 768px)');
    expect(css).toContain('.pos-shell.summary-screen .pos-sidebar');
    expect(css).toContain('.mobile-summary-rank { color: #059669;');
    expect(css).toContain('.pos-shell.summary-screen[data-theme="dark"] .pos-main');
    expect(css).toContain('.pos-shell.summary-screen[data-theme="dark"] .mobile-summary-card');
    expect(css).toContain('.pos-shell.summary-screen[data-theme="dark"] .pos-summary-mobile-nav');
    expect(css).toContain('background: rgba(12, 28, 23, .94)');
    expect(css).toContain('color: #f8fafc;');
  });
});
