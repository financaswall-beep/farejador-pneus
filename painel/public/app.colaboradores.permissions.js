// Subaba de permissões da Matriz. A mesma lista alimenta o menu e as guardas
// centrais do servidor; nenhuma chave existe apenas para efeito visual.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.colaboradoresPermissions = function () {
  return {
    async colabCarregarPermissoes(c) {
      if (!c?.id) return;
      this.colabPermLoading = true;
      try {
        const payload = await this.apiGet(`/admin/api/colaboradores/${c.id}/permissoes-operacao`);
        this.colabPermForm = Object.fromEntries((payload.available_permissions || [])
          .map((key) => [key, Boolean(payload.permissions?.[key])]));
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
    colabPermissionCountLabel(c) {
      if (c?.panel_role === 'owner') return `${this.colabPermAvailable.length || 13} módulos`;
      if (this.colabSelectedId === c?.id && Object.keys(this.colabPermForm || {}).length) {
        return `${Object.values(this.colabPermForm).filter(Boolean).length} módulos`;
      }
      return c?.panel_role ? 'Personalizado' : 'Sem painel';
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
        resumo: ['Resumo', 'Visão geral da operação', 'layout-dashboard'],
        bot: ['Bot', 'Movimento, conversas e demanda', 'bot'],
        vendas: ['Vendas', 'Registrar e consultar vendas', 'shopping-cart'],
        retiradas: ['Retiradas', 'Pedidos reservados e atendimento', 'package-check'],
        clientes: ['Clientes', 'Leads, histórico e relacionamento', 'users'],
        compras: ['Compras', 'Fornecedores e abastecimento', 'shopping-basket'],
        estoque: ['Estoque', 'Consultar e movimentar estoque', 'package'],
        logistica: ['Logística', 'Rotas, entregas e comprovantes', 'truck'],
        financeiro: ['Financeiro', 'Caixa e consultas financeiras', 'circle-dollar-sign'],
        rede: ['Rede', 'Unidades, parceiros e consolidação', 'network'],
        marketing: ['Marketing', 'Campanhas, investimento e conversão', 'megaphone'],
        colaboradores: ['Colaboradores', 'Equipe, remuneração e permissões', 'users-round'],
        catalogo: ['Catálogo', 'Produtos, preços e compatibilidades', 'tag'],
      })[key] || [key, '', 'shield-check'];
    },
    colabApplyPermissionModel() {
      const presets = {
        vendedor: ['resumo', 'vendas', 'retiradas', 'clientes', 'catalogo'],
        estoque: ['resumo', 'compras', 'estoque', 'catalogo'],
        entregador: ['resumo', 'retiradas', 'logistica'],
        administrativo: ['resumo', 'compras', 'financeiro', 'colaboradores', 'catalogo'],
        gerente: this.colabPermAvailable,
      };
      const selected = presets[this.colabPermissionModel];
      if (!selected) return;
      const enabled = new Set(selected);
      this.colabPermForm = Object.fromEntries(this.colabPermAvailable
        .map((key) => [key, enabled.has(key)]));
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
