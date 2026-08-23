// Controle owner-only do canário. A chave é por unidade e o desligamento volta
// o próximo acesso para o painel legado, sem deploy ou migration reversa.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.redeCanario = function () {
  return {
    modernPanelSaving: false,
    modernPanelMsg: '',
    modernPanelHealth: null,
    modernPanelHealthUnitId: '',

    async loadModernPanelCanaryHealth(force = false) {
      const unit = this.selectedParceiro();
      if (!unit || this.adminUser?.role !== 'owner') return;
      if (!force && this.modernPanelHealthUnitId === unit.id) return;
      this.modernPanelHealthUnitId = unit.id;
      this.modernPanelHealth = null;
      try {
        this.modernPanelHealth = await this.apiGet(
          `/admin/api/partners/${encodeURIComponent(unit.id)}/modern-panel/telemetry`,
        );
      } catch (_) {
        this.modernPanelHealthUnitId = '';
      }
    },

    async salvarPainelModerno(ligar) {
      const unit = this.selectedParceiro();
      if (!unit || this.adminUser?.role !== 'owner' || this.modernPanelSaving) return;
      const enabled = Boolean(ligar);
      if (enabled === Boolean(unit.painelModerno)) return;
      if (enabled && !confirm(
        `Liberar o painel moderno para "${unit.nome || 'esta unidade'}"?\n\n`
        + 'O canário inclui Resumo e Retiradas. Desligar esta chave faz o próximo acesso voltar ao painel antigo.',
      )) return;
      const previous = unit.painelModerno;
      unit.painelModerno = enabled;
      this.modernPanelSaving = true;
      this.modernPanelMsg = '';
      try {
        await this.apiPut(`/admin/api/partners/${encodeURIComponent(unit.id)}/modern-panel`, {
          modern_panel_enabled: enabled,
        });
        this.modernPanelMsg = enabled
          ? 'Canário liberado para esta unidade.'
          : 'Canário desligado; o painel antigo volta no próximo acesso.';
        await this.loadModernPanelCanaryHealth(true);
      } catch (err) {
        unit.painelModerno = previous;
        const code = String(err?.message || err);
        this.modernPanelMsg = code === 'admin_owner_required'
          ? 'Só o dono da Matriz pode mudar o canário.'
          : `Erro ao salvar: ${code}`;
      } finally {
        this.modernPanelSaving = false;
      }
    },
  };
};
