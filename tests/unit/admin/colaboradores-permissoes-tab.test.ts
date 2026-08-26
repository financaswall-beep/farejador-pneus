import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = (file: string) => readFileSync(resolve(file), 'utf8');

function moduleOf(file: string, name: string) {
  const sandbox: any = { window: { PAINEL_MODULES: {} }, Date, Intl, Set, Object, encodeURIComponent };
  vm.runInNewContext(source(file), sandbox, { filename: file });
  return sandbox.window.PAINEL_MODULES[name]();
}

function appWith(module: object, extra: object) {
  const app: any = { $nextTick: (fn: Function) => fn(), ...extra };
  Object.defineProperties(app, Object.getOwnPropertyDescriptors(module));
  return app;
}

describe('aba de permissões dos colaboradores', () => {
  it('entrega a mesma estrutura visual na Matriz e no parceiro', () => {
    const html = source('painel/public/index.html');
    expect(html).toContain("partnerColaboradoresSetTab('permissoes')");
    expect(html).toContain("colabTab === 'permissoes'");
    expect(html).toContain('Modelo de acesso');
    expect(html).toContain('Encerrar sessões');
    expect(html).toContain('Setores permitidos na Matriz');
    expect(html).toContain('class="permission-toggle"');
    expect(html).toContain('Estas permissões valem somente para esta unidade');
  });

  it('aplica modelo e salva somente a allowlist real do parceiro', async () => {
    const write = vi.fn().mockResolvedValue({});
    const load = vi.fn().mockResolvedValue(undefined);
    const app = appWith(moduleOf(
      'painel/public/app.partner-colaboradores.permissions.js', 'partnerColaboradoresPermissions',
    ), {
      partnerApiWrite: write, loadPartnerColaboradores: load,
      partnerColaboradores: {
        permissionModel: 'estoque', selected: { id: 'u1', name: 'Ana' },
        saving: false, detailLoading: false, detailError: null,
        detail: { permissions: {} }, rows: [],
      },
    });
    app.partnerColaboradoresApplyPermissionModel();
    expect(app.partnerColaboradores.detail.permissions).toMatchObject({
      estoque: true, pedidos: true, retiradas: true, vendas: false, financeiro: false,
    });
    await app.partnerColaboradoresSavePermissions();
    expect(write).toHaveBeenCalledWith('equipe/u1/permissoes', 'PUT', expect.objectContaining({
      estoque: true, pedidos: true, retiradas: true,
    }));
  });

  it('aplica modelo da Matriz e usa endpoints protegidos para salvar e encerrar sessões', async () => {
    const put = vi.fn().mockResolvedValue({});
    const post = vi.fn().mockResolvedValue({});
    const app = appWith(moduleOf(
      'painel/public/app.colaboradores.permissions.js', 'colaboradoresPermissions',
    ), {
      apiPut: put, apiPost: post, colabPermissionModel: 'gerente', colabPermForm: {},
      colabPermAvailable: ['resumo', 'bot', 'vendas', 'retiradas', 'clientes', 'compras', 'estoque', 'logistica', 'financeiro', 'rede', 'marketing', 'colaboradores', 'catalogo'],
      colabPermLocked: false, colabSaving: false, colabSelectedId: 'c1',
      colabSelected: { id: 'c1', display_name: 'Ana', panel_role: 'admin' },
      colaboradores: [{ id: 'c1', display_name: 'Ana' }],
    });
    app.colabApplyPermissionModel();
    expect(app.colabPermForm).toMatchObject({
      resumo: true, bot: true, vendas: true, compras: true, estoque: true,
      logistica: true, financeiro: true, rede: true, marketing: true,
      colaboradores: true, catalogo: true,
    });
    await app.colabSalvarPermissoes();
    await app.colabEndSessions();
    expect(put).toHaveBeenCalledWith('/admin/api/colaboradores/c1/permissoes-operacao', app.colabPermForm);
    expect(post).toHaveBeenCalledWith('/admin/api/colaboradores/encerrar-sessoes', { id: 'c1' });
  });

  it('mantém os endpoints de sessão restritos ao dono e escopados no SQL', () => {
    const matrixRoute = source('src/admin/painel/route-colaboradores.ts');
    const partnerRoute = source('src/parceiro/route.ts');
    const matrixQuery = source('src/admin/painel/queries-colaboradores-acesso.ts');
    const partnerQuery = source('src/parceiro/queries.ts');
    expect(matrixRoute).toContain("'/admin/api/colaboradores/encerrar-sessoes', { preHandler: requireAdminOwner }");
    expect(partnerRoute).toContain("'/parceiro/:slug/api/funcionarios/:tokenId/encerrar-sessoes', { preHandler: ownerOnly }");
    expect(matrixQuery).toContain('mc.environment=$1 AND mc.id=$2');
    expect(partnerQuery).toContain('partner_unit_id=$3');
  });
});
