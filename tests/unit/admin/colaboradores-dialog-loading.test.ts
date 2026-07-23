import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = (path: string) => readFileSync(resolve(path), 'utf8');

function loadGestao(integrity: object = {}) {
  const sandbox = { window: { PAINEL_MODULES: {}, PAINEL_INTEGRITY: integrity } };
  vm.runInNewContext(source('painel/public/app.colaboradores.gestao.js'), sandbox);
  return (sandbox.window.PAINEL_MODULES as Record<string, () => Record<string, Function>>).colaboradoresGestao();
}

describe('Colaboradores - dialogos e carregamento confiaveis', () => {
  const colaboradores = source('painel/public/app.colaboradores.js');
  const gestao = source('painel/public/app.colaboradores.gestao.js');
  const app = source('painel/public/app.js');
  const html = source('painel/public/index.html');

  it('nao usa dialogos nativos nos quatro fluxos corrigidos', () => {
    expect(colaboradores).not.toMatch(/\b(?:window\.)?(?:confirm|prompt|alert)\s*\(/);
    expect(gestao).not.toMatch(/\b(?:window\.)?(?:confirm|prompt|alert)\s*\(/);
  });

  it('oferece um dialogo acessivel para senha, revogacao, fechamento e pagamento', () => {
    expect(app).toContain('colabDialog:');
    expect(gestao).toContain('abrirColabDialog(kind, collaborator = null)');
    expect(gestao).toContain('async confirmarColabDialog()');
    expect(html).toContain('aria-labelledby="colab-dialog-title"');
    expect(html).toContain('x-ref="colabDialogPassword"');
    expect(html).toContain('x-text="colabDialogConfirmLabel()"');

    for (const kind of ['password', 'revoke', 'close-payroll', 'pay-payroll']) {
      expect(gestao).toContain(`'${kind}'`);
    }
  });

  it('mantem as rotas e a integridade dos efeitos confirmados', () => {
    expect(gestao).toContain("'/admin/api/colaboradores/senha'");
    expect(gestao).toContain("'/admin/api/colaboradores/revogar'");
    expect(gestao).toContain("'/admin/api/colaboradores/folha/fechar'");
    expect(gestao).toContain("'/admin/api/colaboradores/folha/pagar'");
    expect(gestao).toContain("window.PAINEL_INTEGRITY.operation('matriz-payroll-payment'");
    expect(gestao).toContain("window.PAINEL_INTEGRITY.complete('matriz-payroll-payment'");
  });

  it('nao envia senha curta e limpa o segredo ao fechar o dialogo', async () => {
    const module = loadGestao();
    const apiPost = vi.fn();
    const context = {
      colabSaving: false,
      colabMsg: null,
      colabDialog: {
        open: true, kind: 'password', collaborator: { id: 'c1', display_name: 'Ana' },
        password: 'curta', showPassword: false, error: null,
      },
      apiPost,
      fecharColabDialog: module.fecharColabDialog,
    };

    await module.confirmarColabDialog.call(context);
    expect(apiPost).not.toHaveBeenCalled();
    expect(context.colabDialog.error).toContain('12 caracteres');

    context.colabDialog.password = 'senha-segura-123';
    await module.confirmarColabDialog.call(context);
    expect(apiPost).toHaveBeenCalledWith('/admin/api/colaboradores/senha', {
      id: 'c1', password: 'senha-segura-123',
    });
    expect(context.colabDialog).toMatchObject({ open: false, password: '', collaborator: null });
  });

  it('so executa revogacao, fechamento e pagamento depois da confirmacao interna', async () => {
    const operation = vi.fn().mockReturnValue({ key: 'idem-1' });
    const complete = vi.fn();
    const module = loadGestao({ operation, complete });
    const apiPost = vi.fn().mockResolvedValue(undefined);
    const loadColaboradores = vi.fn().mockResolvedValue(undefined);
    const loadFinanceiro = vi.fn().mockResolvedValue(undefined);
    const colabCloseDrawer = vi.fn();
    const collaborator = { id: 'c1', display_name: 'Ana', payroll_item_id: 'item-1', total_due: 250 };
    const context = (kind: string, selected: object | null) => ({
      colabSaving: false,
      colabMsg: null,
      colabMes: '2026-07',
      colabDialog: { open: true, kind, collaborator: selected, password: '', showPassword: false, error: null },
      apiPost,
      loadColaboradores,
      loadFinanceiro,
      colabCloseDrawer,
      fecharColabDialog: module.fecharColabDialog,
    });

    await module.confirmarColabDialog.call(context('revoke', collaborator));
    await module.confirmarColabDialog.call(context('close-payroll', null));
    await module.confirmarColabDialog.call(context('pay-payroll', collaborator));

    expect(apiPost.mock.calls).toEqual([
      ['/admin/api/colaboradores/revogar', { id: 'c1' }],
      ['/admin/api/colaboradores/folha/fechar', { competence: '2026-07-01' }],
      ['/admin/api/colaboradores/folha/pagar', { item_id: 'item-1', idempotency_key: 'idem-1' }],
    ]);
    expect(operation).toHaveBeenCalledWith('matriz-payroll-payment', 'item-1');
    expect(complete).toHaveBeenCalledWith('matriz-payroll-payment', 'item-1');
  });

  it('mostra carregamento, erro e tentativa novamente sem exibir zero falso', () => {
    expect(app).toContain('colabLoading: false');
    expect(app).toContain('colabLoadError: null');
    expect(colaboradores).toContain('this.colabLoading = true');
    expect(colaboradores).toContain('this.colabLoaded = false');
    expect(colaboradores).toContain('this.colabLoadError = null');
    expect(colaboradores).toMatch(/finally\s*\{[\s\S]*this\.colabLoading = false/);
    expect(html).toContain('x-show="colabLoading"');
    expect(html).toContain('x-show="!colabLoading && colabLoadError"');
    expect(html).toContain('@click="loadColaboradores()"');
    expect(html).toContain('x-show="!colabLoading && !colabLoadError && colabLoaded"');
  });

  it('invalida o cache dos tres scripts alterados', () => {
    expect(html).toContain('app.colaboradores.js?v=20260719-colab-dialog1');
    expect(html).toContain('app.colaboradores.gestao.js?v=20260719-colab-dialog1');
    expect(html).toContain('app.js?v=20260723-rede-fix1');
  });
});
