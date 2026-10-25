window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.dotAlerts = function () {
  const fields = {
    'farejador.conversa.atualizada': [['wait_minutes', 'Cliente esperando resposta (minutos)', 1, 120]],
    'farejador.entrega.atencao': [['delivery_stale_hours', 'Sem atualização há quantas horas?', 1, 168]],
    'farejador.estoque.procura': [['demand_contacts', 'Clientes diferentes buscando a medida', 2, 100], ['demand_hours', 'Considerar as últimas horas', 1, 168]],
    'farejador.estoque.disponivel': [],
    'farejador.atendimento.inconsistencia': [['quote_hours', 'Considerar bloqueios das últimas horas', 1, 48]],
    'farejador.financeiro.atencao': [['due_days', 'Avisar quantos dias antes do vencimento?', 0, 30]],
    'farejador.marketing.atencao': [['marketing_spend_brl', 'Gasto mínimo para conferir (R$)', 1, 1000000], ['marketing_min_results', 'Mínimo de resultados na plataforma', 1, 1000], ['marketing_days', 'Período em dias, incluindo hoje', 1, 30]],
    'farejador.sistema.atencao': [['system_stale_minutes', 'Tolerância de atraso em filas e sincronizações (minutos)', 5, 1440], ['external_failures', 'Falhas seguidas no monitor externo', 2, 10]],
  };
  return {
    dotAlerts: { loaded: false, loading: false, saving: false, error: '', message: '', data: null, form: null, version: 0 },
    dotAlertFields(name) { return fields[name] || []; },
    dotAlertConnection(name) {
      if (this.dotAlerts.data?.source_checks?.[name]?.available === false) return 'Fonte indisponível: não foi possível avaliar este tipo.';
      return this.dotAlerts.data?.subscriptions?.some(item => item.event_name === name)
        ? 'Assistente com assinatura ativa.' : 'Sem assinatura ativa. Peça ao assistente para acompanhar este tipo.';
    },
    async dotAlertsLoad() {
      if (this.adminUser?.role !== 'owner' || this.dotAlerts.loading) return;
      this.dotAlerts.loaded = true; this.dotAlerts.loading = true; this.dotAlerts.error = ''; this.dotAlerts.message = '';
      try {
        const data = await this.apiGet('/admin/api/dot/alerts');
        this.dotAlerts.data = data; this.dotAlerts.form = JSON.parse(JSON.stringify(data.settings)); this.dotAlerts.version = data.version;
      } catch (_) { this.dotAlerts.error = 'Não foi possível carregar os controles. Confira a conexão e tente novamente.'; }
      finally { this.dotAlerts.loading = false; }
    },
    async dotAlertsSave() {
      if (this.adminUser?.role !== 'owner' || this.dotAlerts.saving || !this.dotAlerts.form) return;
      this.dotAlerts.saving = true; this.dotAlerts.error = ''; this.dotAlerts.message = '';
      try {
        const saved = await this.apiPut('/admin/api/dot/alerts', { settings: this.dotAlerts.form, version: this.dotAlerts.version });
        this.dotAlerts.version = saved.version; this.dotAlerts.form = JSON.parse(JSON.stringify(saved.settings));
        this.dotAlerts.message = 'Preferências salvas. As novas regras serão usadas nos próximos envios.';
      } catch (error) {
        this.dotAlerts.error = String(error?.message).includes('dot_settings_conflict')
          ? 'As preferências mudaram em outra tela. Recarregue antes de salvar novamente.'
          : 'Não foi possível salvar. Confira os limites preenchidos e tente novamente.';
      } finally { this.dotAlerts.saving = false; }
    },
    dotAlertsRuntimeLabel() {
      const state = this.dotAlerts.data?.runtime;
      if (!state) return 'Carregando conexão';
      if (!state.enabled) return 'Envio indisponível no servidor';
      if (this.dotAlerts.form?.paused) return 'Todos os avisos pausados';
      return (this.dotAlerts.data?.subscriptions?.length || 0) + ' acompanhamento(s) conectado(s)';
    },
  };
};
