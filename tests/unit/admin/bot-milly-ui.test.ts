import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function painel() {
  const sandbox = { window: { PAINEL_MODULES: {} as Record<string, () => Record<string, any>> } };
  runInNewContext(readFileSync('painel/public/app.bot.milly.js', 'utf8'), sandbox);
  const ui = sandbox.window.PAINEL_MODULES.botMilly!();
  Object.assign(ui, {
    adminAuthenticated: true, panelScope: 'matrix', adminUser: { role: 'owner', auth_type: 'session' },
    apiGet: vi.fn(), apiPut: vi.fn(),
  });
  return ui;
}

describe('botão da Milly no painel da Matriz', () => {
  it('usa a confirmação do servidor e descarta a leitura antiga que termina depois da pausa', async () => {
    const ui = painel();
    let confirmar!: (estado: unknown) => void;
    ui.apiGet.mockResolvedValueOnce({ ativa: true, canal_disponivel: false, fluxo_disponivel: true });
    await ui.carregarConsultaMilly();
    expect(ui.consultaMillyStatus).toContain('Canal da Milly indisponível');
    ui.apiGet.mockReturnValueOnce(new Promise(resolve => { confirmar = resolve; }));
    const antiga = ui.carregarConsultaMilly();
    ui.apiPut.mockResolvedValueOnce({ ativa: false });
    await ui.alterarConsultaMilly();
    confirmar({ ativa: true, canal_disponivel: true });
    await antiga;
    expect(ui.consultaMillyAtiva).toBe(false);
    expect(ui.apiPut).toHaveBeenCalledWith('/admin/api/bot/consulta-milly', { ativa: false });
  });

  it('recupera o estado quando a confirmação se perde, sem reenviar a alteração', async () => {
    const ui = painel();
    ui.consultaMillyAtiva = false;
    ui.apiPut.mockRejectedValueOnce(new Error('offline'));
    await ui.alterarConsultaMilly();
    expect(ui.consultaMillyAtiva).toBeNull();
    expect(ui.consultaMillyStatus).toContain('não foi confirmada');
    ui.apiGet.mockResolvedValueOnce({ ativa: true, canal_disponivel: true });
    await ui.alterarConsultaMilly();
    expect(ui.consultaMillyAtiva).toBe(true);
    expect(ui.apiPut).toHaveBeenCalledOnce();
  });

  it('distingue canal conectado de instalação pronta e deixa o dono pausar', async () => {
    const ui = painel();
    ui.apiGet.mockResolvedValueOnce({ ativa: true, canal_disponivel: true, fluxo_disponivel: false });
    await ui.carregarConsultaMilly();
    expect(ui.consultaMillyStatus).toContain('envio em fila habilitados');
    ui.apiPut.mockResolvedValueOnce({ ativa: false, fluxo_disponivel: false });
    await ui.alterarConsultaMilly();
    expect(ui.consultaMillyStatus).toContain('Consultas pausadas');
  });

  it('exibe a ação apenas ao dono da Matriz nas abas de operação do Bot', async () => {
    const ui = painel();
    ui.adminUser.role = 'admin';
    await ui.carregarConsultaMilly();
    await ui.alterarConsultaMilly();
    expect(ui.apiGet).not.toHaveBeenCalled();
    expect(ui.apiPut).not.toHaveBeenCalled();
    const html = readFileSync('painel/public/index.html', 'utf8');
    expect(html).toContain("podeControlarMilly && ['visao', 'conversas'].includes(botTab)");
    expect(html).toContain("Parar consultas à Milly");
    expect(html).toContain("Consultar a Milly");
  });
});
