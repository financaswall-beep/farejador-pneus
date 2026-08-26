// Subaba de permissões da Matriz. Só expõe permissões que têm guarda real no
// servidor; áreas administrativas continuam subordinadas ao papel do painel.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.colaboradoresPermissions = function () {
  return {
    async colabCarregarPermissoes(c) {
      if (!c?.id) return;
      this.colabPermLoading = true;
      try {
        const payload = await this.apiGet(`/admin/api/colaboradores/${c.id}/permissoes-operacao`);
        this.colabPermForm = {
          vendas: !!payload.permissions?.vendas, estoque: !!payload.permissions?.estoque,
          entregas: !!payload.permissions?.entregas, financeiro: !!payload.permissions?.financeiro,
        };
        this.colabPermAvailable = payload.available_permissions || [];
        this.colabPermLocked = !!payload.locked;
      } catch (err) {
        this.colabMsg = { ok: false, text: `Não consegui carregar as permissões (${err.message}).` };
      } finally { this.colabPermLoading = false; }
    },
    get colabPermissoesRows() {
      const base = this.colabView === 'revogados' ? this.colabRevogadosLista : this.colabAtivos;
      const query = String(this.colabBusca || '').trim().toLocaleLowerCase('pt-BR');
      return base.filter((c) => !query || `${c.display_name} ${c.username} ${c.job_title}`
        .toLocaleLowerCase('pt-BR').includes(query));
    },
    get colabSemPainelCount() { return this.colabAtivos.filter((c) => !c.panel_role).length; },
    get colabSemUso30Count() {
      const limit = Date.now() - (30 * 24 * 60 * 60 * 1000);
      return this.colabAtivos.filter((c) => c.last_used_at
        && new Date(c.last_used_at).getTime() < limit).length;
    },
    colabLastAccess(c) {
      if (!c?.last_used_at) return 'Nunca acessou';
      const date = new Date(c.last_used_at);
      if (Number.isNaN(date.getTime())) return 'Nunca acessou';
      return new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short',
      }).format(date);
    },
    colabPermissionMeta(key) {
      return ({
        vendas: ['Vendas', 'Registrar e consultar vendas', 'shopping-cart'],
        estoque: ['Estoque', 'Consultar e movimentar estoque', 'package'],
        entregas: ['Logística', 'Rotas, entregas e comprovantes', 'truck'],
        financeiro: ['Financeiro', 'Caixa e consultas financeiras', 'circle-dollar-sign'],
      })[key] || [key, '', 'shield-check'];
    },
    colabApplyPermissionModel() {
      const presets = {
        vendedor: { vendas: true, estoque: false, entregas: false, financeiro: false },
        estoque: { vendas: false, estoque: true, entregas: false, financeiro: false },
        entregador: { vendas: false, estoque: false, entregas: true, financeiro: false },
        gerente: { vendas: true, estoque: true, entregas: true, financeiro: true },
      };
      if (presets[this.colabPermissionModel]) this.colabPermForm = { ...presets[this.colabPermissionModel] };
    },
    async colabOpenPermissions(c) {
      this.colabSelectedId = c.id; this.colabDrawer = null; this.colabPermissionModel = 'custom';
      await this.colabCarregarPermissoes(c);
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    async colabTogglePanelAccess() {
      const c = this.colabSelected;
      if (!c || c.panel_role === 'owner') return;
      await this.mudarAcessoColaborador(c, c.panel_role ? null : 'admin');
      const refreshed = this.colaboradores.find((row) => row.id === c.id);
      if (refreshed) await this.colabOpenPermissions(refreshed);
    },
    async colabEndSessions() {
      const c = this.colabSelected;
      if (!c || this.colabSaving) return;
      this.colabSaving = true;
      try {
        await this.apiPost('/admin/api/colaboradores/encerrar-sessoes', { id: c.id });
        this.colabMsg = { ok: true, text: `Sessões de ${c.display_name} encerradas.` };
      } catch (err) { this.colabMsg = { ok: false, text: `Não consegui encerrar as sessões (${err.message}).` }; }
      finally { this.colabSaving = false; }
    },
    async colabSalvarPermissoes() {
      const c = this.colabSelected; if (!c || this.colabPermLocked) return;
      this.colabSaving = true; this.colabMsg = null;
      try {
        await this.apiPut(`/admin/api/colaboradores/${c.id}/permissoes-operacao`, this.colabPermForm);
        this.colabMsg = { ok: true, text: `Permissões de ${c.display_name} atualizadas. O login anterior foi encerrado por segurança.` };
      } catch (err) { this.colabMsg = { ok: false, text: `Não consegui salvar as permissões (${err.message}).` }; }
      finally { this.colabSaving = false; }
    },
  };
};
