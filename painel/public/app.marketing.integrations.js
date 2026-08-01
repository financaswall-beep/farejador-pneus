// Marketing / Integrações: estado técnico read-only + gerador local de UTM.
// Nenhum botão grava credencial, altera campanha ou presume conexão.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};

function marketingIntegrationMockPayload() {
  return {
    environment: 'test',
    generated_at: '2026-07-26T11:35:00.000Z',
    summary: {
      connected: 1, total: 3, last_sync_at: '2026-07-26T11:35:00.000Z',
      quality_percent: 82, critical_pending: 2,
    },
    platforms: [
      {
        id: 'meta', label: 'Meta Ads', status: 'connected', account_masked: 'act_••••4821',
        last_sync_at: '2026-07-26T11:35:00.000Z',
        imported: ['Campanhas', 'Investimento', 'Conversas'],
      },
      { id: 'google', label: 'Google Ads', status: 'not_connected', account_masked: null, last_sync_at: null, imported: [] },
      { id: 'tiktok', label: 'TikTok Ads', status: 'planned', account_masked: null, last_sync_at: null, imported: [] },
    ],
    pipeline: [
      { id: 'platform', label: 'Plataforma', status: 'ok' },
      { id: 'collection', label: 'Coleta', status: 'ok' },
      { id: 'normalization', label: 'Normalização', status: 'ok' },
      { id: 'attribution', label: 'Atribuição', status: 'pending' },
      { id: 'profit', label: 'Vendas e lucro', status: 'blocked' },
    ],
    collection: [
      { id: 'campaigns', label: 'Campanhas e investimento', status: 'ok', detail: 'recebendo' },
      { id: 'conversations', label: 'Conversas por anúncio', status: 'ok', detail: 'recebendo' },
      { id: 'ctwa', label: 'Referências de mensagem', status: 'ok', detail: '61 referência(s)' },
      { id: 'capi', label: 'CAPI', status: 'pending', detail: 'implementada e desligada até passar no Test Events' },
    ],
    quality: [
      { id: 'credential', label: 'Credencial protegida', status: 'ok' },
      { id: 'account', label: 'Conta de anúncios', status: 'ok' },
      { id: 'sync', label: 'Sincronização', status: 'ok' },
      { id: 'ctwa', label: 'Atribuição multicanal', status: 'ok' },
      { id: 'capi', label: 'Retorno CAPI', status: 'pending' },
    ],
    next_step: 'Validar Purchase no Test Events e ativar a CAPI',
    sync: { available: true, status: 'succeeded', rows_upserted: 146 },
    capi: { enabled: false, pending: 0, processing: 0, sent: 0, dead_letter: 0, suppressed: 0 },
    audit_events: [
      { id: '1', event_type: 'Meta sincronizada', actor_label: 'Sistema', created_at: '2026-07-26T11:35:00.000Z' },
      { id: '2', event_type: 'Credencial validada', actor_label: 'Sistema', created_at: '2026-07-26T11:34:00.000Z' },
      { id: '3', event_type: 'Configuração alterada', actor_label: 'Administrador', created_at: '2026-07-25T20:22:00.000Z' },
      { id: '4', event_type: 'Importação concluída', actor_label: 'Sistema', created_at: '2026-07-25T19:58:00.000Z' },
    ],
  };
}

window.PAINEL_MODULES.marketingIntegrations = function () {
  return {
    async loadMarketingIntegrations() {
      if (this.marketingIntegrationsLoading) return;
      this.marketingIntegrationsLoading = true;
      this.marketingIntegrationsError = null;
      try {
        this.marketingIntegrations = this.marketingIsMock()
          ? marketingIntegrationMockPayload()
          : await this.apiGet(`/admin/api/marketing/integrations?period=${encodeURIComponent(this.marketingPeriod)}`);
      } catch {
        this.marketingIntegrationsError = 'Não foi possível carregar as integrações agora.';
      } finally {
        this.marketingIntegrationsLoading = false;
        this.$nextTick(() => lucide.createIcons());
      }
    },

    marketingIntegrationSummary() {
      const summary = this.marketingIntegrations?.summary || {};
      return [
        { id: 'platforms', label: 'Plataformas conectadas',
          value: `${summary.connected ?? 0} de ${summary.total ?? 3}`, icon: 'share-2' },
        { id: 'sync', label: 'Última sincronização',
          value: summary.last_sync_at ? this.formatDateTime(summary.last_sync_at) : 'Sem sincronização', icon: 'clock-3' },
        { id: 'quality', label: 'Qualidade da coleta',
          value: `${summary.quality_percent ?? 0}%`, icon: 'shield-check' },
        { id: 'pending', label: 'Pendências críticas',
          value: summary.critical_pending ?? 0, icon: 'triangle-alert' },
      ];
    },

    marketingIntegrationStatusLabel(status) {
      const labels = {
        connected: 'Conectado', disabled: 'Desativado', not_configured: 'Não configurado',
        error: 'Falha de sincronização', not_connected: 'Não conectado', planned: 'Planejado',
        ok: 'OK', pending: 'Pendente', blocked: 'Não configurado',
      };
      return labels[status] || status;
    },

    marketingIntegrationStatusClass(status) {
      if (status === 'connected' || status === 'ok') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
      if (status === 'error') return 'border-emerald-300 bg-emerald-100 text-emerald-950';
      if (status === 'planned') return 'border-emerald-100 bg-emerald-50/70 text-emerald-700';
      return 'border-gray-200 bg-gray-50 text-gray-600';
    },

    marketingIntegrationStatusIcon(status) {
      if (status === 'connected' || status === 'ok') return 'check';
      if (status === 'error') return 'triangle-alert';
      if (status === 'blocked') return 'lock-keyhole';
      return 'clock-3';
    },

    marketingIntegrationAuditLabel(eventType) {
      const labels = {
        marketing_campaign_scope_set: 'Escopo da campanha',
        marketing_sync_manual: 'Sincronização manual da Meta',
        marketing_attribution_reconciled: 'Atribuição reconciliada',
        marketing_capi_test: 'Teste CAPI',
      };
      return labels[eventType] || eventType;
    },

    async marketingIntegrationAction(platform) {
      if (platform.id === 'meta' && platform.status === 'connected') {
        await this.marketingRunIntegrationAction('sync');
      } else if (platform.id === 'google') {
        this.marketingIntegrationsMessage = 'Google Ads ainda não possui conector. Nenhuma configuração foi alterada.';
      } else {
        this.marketingIntegrationsMessage = 'TikTok Ads está planejado. Nenhuma configuração foi alterada.';
      }
    },

    marketingIntegrationActionLabel(platform) {
      if (platform.id === 'meta' && platform.status === 'connected') return 'Sincronizar Meta';
      if (platform.id === 'google') return 'Sem conector';
      return 'Planejado';
    },

    async marketingRunIntegrationAction(action) {
      if (this.marketingIntegrationActionLoading) return;
      this.marketingIntegrationActionLoading = action;
      this.marketingIntegrationsMessage = '';
      try {
        if (this.marketingIsMock()) {
          this.marketingIntegrationsMessage = action === 'sync'
            ? 'Amostra: 146 linhas seriam sincronizadas.'
            : action === 'reconcile'
              ? 'Amostra: atribuições seriam reconciliadas e enfileiradas.'
              : 'Amostra: Purchase seria enviado ao Test Events.';
          return;
        }
        if (action === 'sync') {
          const result = await this.apiPost('/admin/api/marketing/sync', { lookback_days: 60 });
          this.marketingIntegrationsMessage = `Sincronização concluída: ${result.rows_upserted || 0} linha(s) persistidas.`;
        } else if (action === 'reconcile') {
          const result = await this.apiPost('/admin/api/marketing/reconcile', {});
          this.marketingIntegrationsMessage = `Reconciliação concluída: ${result.attribution?.created || 0} nova(s) atribuição(ões), ${result.capi_enqueued || 0} evento(s) enfileirado(s).`;
        } else {
          const result = await this.apiPost('/admin/api/marketing/capi/test', {});
          this.marketingIntegrationsMessage = result.processed
            ? 'Um Purchase foi enviado ao Test Events da Meta.'
            : 'Nenhuma compra recente elegível foi encontrada para o Test Events.';
        }
        await this.loadMarketingIntegrations();
      } catch (error) {
        const code = error?.message || '';
        this.marketingIntegrationsMessage = code === 'capi_test_event_code_not_configured'
          ? 'Configure META_CAPI_TEST_EVENT_CODE antes de testar a CAPI.'
          : 'A ação não foi concluída. Confira a configuração e o diagnóstico do pipeline.';
      } finally {
        this.marketingIntegrationActionLoading = '';
        this.$nextTick(() => lucide.createIcons());
      }
    },

    marketingUtmUrl() {
      const form = this.marketingUtmForm;
      const base = String(form.base_url || '').trim();
      if (!/^https?:\/\//i.test(base)) return '';
      try {
        const url = new URL(base);
        const fields = [
          ['utm_source', form.source],
          ['utm_medium', form.medium],
          ['utm_campaign', form.campaign],
          ['utm_content', form.content],
        ];
        fields.forEach(([key, value]) => {
          const normalized = String(value || '').trim();
          if (normalized) url.searchParams.set(key, normalized);
        });
        return url.toString();
      } catch {
        return '';
      }
    },

    marketingUtmValid() {
      return Boolean(this.marketingUtmUrl() && this.marketingUtmForm.source
        && this.marketingUtmForm.medium && this.marketingUtmForm.campaign);
    },

    async marketingCopyUtm() {
      const value = this.marketingUtmUrl();
      if (!this.marketingUtmValid()) {
        this.marketingUtmMessage = 'Preencha URL, origem, mídia e campanha.';
        return;
      }
      try {
        await navigator.clipboard.writeText(value);
        this.marketingUtmMessage = 'Padrão UTM copiado.';
      } catch {
        this.marketingUtmMessage = 'Não foi possível copiar. Selecione a URL manualmente.';
      }
    },

    marketingScrollAudit() {
      this.$refs.marketingIntegrationAudit?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  };
};
