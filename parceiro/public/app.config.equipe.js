/**
 * app.config.equipe.js — Bloco 2 (2026-06-12): ACESSO + COMISSÃO por PESSOA no drawer
 * do funcionário (aba Equipe). Carrega o config do funcionário selecionado e grava
 * telas (PUT funcionarios/:id/permissoes) + comissão (PUT funcionarios/:id/comissao).
 * Backend: migration 0100. O ESTADO (funcConfigLoaded/funcPermForm/funcCommForm) mora
 * na raiz (app.js). REGRA: teto 300 (npm run checar-tamanho); `this` é o objeto de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.configEquipe = () => ({
  // Quantas das 9 telas ESTE funcionário vê (do funcPermForm carregado).
  get funcPermCount() {
    const keys = ['vendas', 'estoque', 'pedidos', 'clientes', 'entregas', 'retiradas', 'batepapo', 'resumo', 'financeiro'];
    return keys.reduce((n, k) => n + (this.funcPermForm && this.funcPermForm[k] ? 1 : 0), 0);
  },

  // Carrega telas + comissão do funcionário aberto (GET .../config). Chamado pelo
  // selectFuncionario (config.js). Funcionário desativado não carrega (some o painel).
  async loadFuncConfig(f) {
    this.funcConfigLoaded = false;
    if (!f || !f.id || f.revoked_at) return;
    try {
      const res = await this.api(`funcionarios/${f.id}/config`);
      const p = res.permissions || {};
      this.funcPermForm = {
        vendas: !!p.vendas, estoque: !!p.estoque, pedidos: !!p.pedidos, clientes: !!p.clientes,
        entregas: !!p.entregas, retiradas: !!p.retiradas, batepapo: !!p.batepapo,
        resumo: !!p.resumo, financeiro: !!p.financeiro,
      };
      const c = res.commission || {};
      this.funcCommForm = {
        kind: c.kind === 'fixed' ? 'fixed' : 'percent',
        value: (c.value !== undefined && c.value !== null) ? Number(c.value) : 0,
        active: !!c.active,
      };
      this.funcConfigLoaded = true;
      this.$nextTick(() => lucide.createIcons());
    } catch (err) {
      console.warn('func_config_unavailable', err);
      this.flash(this.errMessage(err));
    }
  },

  // Salva TELAS + COMISSÃO do funcionário (dois PUT, mesmo botão). Owner-only no backend.
  async saveFuncConfig(f) {
    if (!f || !f.id) return;
    // Comissão ligada exige valor > 0 (senão é "ativa" pagando zero — confunde).
    if (this.funcCommForm.active) {
      const v = Number(this.funcCommForm.value);
      if (!Number.isFinite(v) || v <= 0) { this.flash('Informe o valor da comissão (maior que zero) ou desligue a comissão.'); return; }
      if (this.funcCommForm.kind === 'percent' && v > 100) { this.flash('Comissão em % não pode passar de 100.'); return; }
    }
    this.saving = true; this.savingAction = 'funcConfig';
    try {
      await this.api(`funcionarios/${f.id}/permissoes`, {
        method: 'PUT',
        body: JSON.stringify({
          vendas: !!this.funcPermForm.vendas, estoque: !!this.funcPermForm.estoque,
          pedidos: !!this.funcPermForm.pedidos, clientes: !!this.funcPermForm.clientes,
          entregas: !!this.funcPermForm.entregas, retiradas: !!this.funcPermForm.retiradas,
          batepapo: !!this.funcPermForm.batepapo, resumo: !!this.funcPermForm.resumo,
          financeiro: !!this.funcPermForm.financeiro,
        }),
      });
      await this.api(`funcionarios/${f.id}/comissao`, {
        method: 'PUT',
        body: JSON.stringify({
          kind: this.funcCommForm.kind === 'fixed' ? 'fixed' : 'percent',
          value: this.funcCommForm.active ? Number(this.funcCommForm.value) : 0,
          active: !!this.funcCommForm.active,
        }),
      });
      this.flash('Acesso e comissão salvos.', 'success');
    } catch (err) {
      this.flash(this.errMessage(err));
    } finally {
      this.saving = false; this.savingAction = '';
    }
  },
});
