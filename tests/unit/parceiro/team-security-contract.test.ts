import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync('src/parceiro/route.ts', 'utf8');
const teamRoute = readFileSync('src/parceiro/route-operation-team.ts', 'utf8');
const teamUi = readFileSync('parceiro/public/app.config.equipe.js', 'utf8');
const portal = readFileSync('parceiro/public/index.html', 'utf8');

describe('contrato de segurança e consistência da equipe parceira', () => {
  it('protege busca de clientes e arquivamento pela área consumidora', () => {
    expect(route).toContain("requireAnyScreen('vendas', 'clientes', 'batepapo')");
    expect(route).toContain('requireDismissibleScreen');
    expect(route).toContain("tipo === 'order' ? 'vendas' : 'financeiro'");
  });

  it('exige 12 caracteres para toda senha nova e preserva login legado', () => {
    expect(route).toContain('const loginPasswordField = z.string().min(6)');
    expect(route).toContain('const newPasswordField = z.string().min(12)');
    expect(portal).toContain('Nova senha (mín. 12)');
    expect(portal).toContain('Senha (mín. 12)');
  });

  it('salva função, permissões, remuneração e comissão numa única operação', () => {
    expect(teamRoute).toContain("api/equipe/:collaboratorId/configuracao");
    expect(teamUi).toContain('job_role: this.funcJobRole');
    expect(teamUi).toContain('permissions: {');
    expect(teamUi).toContain('compensation: {');
    expect(teamUi).toContain('commission: {');
    expect(teamUi).toContain('batepapo: !!this.funcPermForm.batepapo');
  });
});
