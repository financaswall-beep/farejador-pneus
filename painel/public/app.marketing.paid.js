// Central de conteúdo pago: apresentação sobre os motores existentes.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
function marketingPaidMockPayload(period) {
  const data = marketingMockPayload(period);
  const campaigns = marketingCampaignMockPayload('meta', period).campaigns.filter(r => r.scope === 'matrix');
  const sum = key => campaigns.reduce((value,r) => value + Number(r[key] || 0),0);
  const spend = sum('investment'), conversations = sum('conversations');
  data.metrics = { ...data.metrics, investment: spend, conversations,
    cost_per_conversation: conversations ? spend / conversations : null, impressions: sum('impressions'), clicks: sum('clicks'),
    ctr: sum('impressions') ? sum('clicks') / sum('impressions') * 100 : null,
    attributed_sales: sum('attributed_sales'), attributed_revenue: sum('attributed_revenue'),
    gross_margin: sum('gross_margin'), net_after_media: sum('profit'), pending_margin_orders: 0 };
  const oldSpend = data.series.reduce((n,r) => n+r.spend,0), oldConversations = data.series.reduce((n,r) => n+r.conversations,0);
  data.series = data.series.map(r => ({ ...r, spend: r.spend / oldSpend * spend, conversations: r.conversations / oldConversations * conversations }));
  data.connection = { ...data.connection, capi: 'enabled', meta_synced_at: data.generated_at };
  data.pipeline = { available: true, identity: { active: true, pending_ads: 0 }, capi: { sent: 28, pending: 3, failed: 0, dead_letter: 0, suppressed: 0 } };
  data.attribution = { ...data.attribution, available: true, tracked: 98 };
  data.alerts = [];
  return data;
}
window.PAINEL_MODULES.marketingPaid = function () {
  let compareTrigger = null;
  return {
    paidScope: 'matrix', paidExpanded: false, paidSort: 'investment', paidAscending: false,
    paidCompareOpen: false, paidCompareIds: [], paidCompareData: null,
    paidMoney(value) { return value == null ? '—' : this.formatCurrency(Number(value)); },
    paidNumber(value) { return value == null ? '—' : Number(value).toLocaleString('pt-BR'); },
    paidDelta(value) {
      return value == null ? 'Sem comparação anterior' : `${value > 0 ? '+' : ''}${this.paidNumber(value)}% vs. período anterior`;
    },
    paidKpis() {
      const m = this.marketingVisao?.metrics || {}, c = this.marketingVisao?.comparison || {};
      return [
        { id: 'investment', label: 'Investimento', value: this.paidMoney(m.investment), icon: 'coins', detail: this.paidDelta(c.spend_delta_percent) },
        { id: 'conversations', label: 'Conversas na Meta', value: this.paidNumber(m.conversations), icon: 'messages-square', detail: this.paidDelta(c.conversations_delta_percent) },
        { id: 'cost', label: 'Custo por conversa', value: this.paidMoney(m.cost_per_conversation), icon: 'tag', detail: 'Investimento ÷ conversas' },
        { id: 'sales', label: 'Vendas atribuídas', value: this.paidNumber(m.attributed_sales), icon: 'shopping-cart', detail: 'Vendas com origem comprovada' },
        { id: 'revenue', label: 'Receita atribuída', value: this.paidMoney(m.attributed_revenue), icon: 'banknote', detail: 'Vendas vinculadas aos anúncios' },
        { id: 'result', label: 'Resultado após mídia', value: this.paidMoney(m.net_after_media), icon: 'trending-up', detail: m.pending_margin_orders > 0 ? `${m.pending_margin_orders} pedido(s) sem custo completo` : 'Receita − custos das vendas − mídia' },
      ];
    },
    paidIndicators() {
      const m = this.marketingVisao?.metrics || {}, a = this.marketingVisao?.attribution;
      return [
        { label: 'Impressões', value: this.paidNumber(m.impressions), icon: 'eye' },
        { label: 'Cliques', value: this.paidNumber(m.clicks), icon: 'mouse-pointer-2' },
        { label: 'CTR', value: m.ctr == null ? '—' : `${this.paidNumber(Math.round(m.ctr * 100) / 100)}%`, icon: 'chart-no-axes-column-increasing' },
        { label: 'ROAS', value: m.investment > 0 && m.attributed_revenue != null ? this.paidNumber(Math.round(m.attributed_revenue / m.investment * 100) / 100) : '—', icon: 'trending-up' },
        { label: 'Conversas rastreadas', value: a?.available ? this.paidNumber(a.tracked) : '—', icon: 'users' },
      ];
    },
    paidRows() {
      return this.marketingCampaignFiltered().filter(row => row.channel === 'meta'
        && (this.paidScope === 'all' || row.scope === this.paidScope)).sort((a, b) => {
        const key = this.paidSort, direction = this.paidAscending ? 1 : -1;
        if (key === 'name') return direction * a.name.localeCompare(b.name, 'pt-BR');
        if (a[key] == null) return b[key] == null ? 0 : 1;
        if (b[key] == null) return -1;
        return direction * (Number(a[key]) - Number(b[key]));
      });
    },
    paidPageRows() { return this.paidRows().slice((this.marketingCampaignPage - 1) * 8, this.marketingCampaignPage * 8); },
    paidPages() { return Math.max(1, Math.ceil(this.paidRows().length / 8)); },
    paidOrder(key) {
      this.paidAscending = this.paidSort === key ? !this.paidAscending : key === 'name';
      this.paidSort = key; this.marketingCampaignPage = 1;
    },
    paidReset() { this.paidScope = 'matrix'; this.marketingCampaignSearch = ''; this.marketingCampaignDecision = 'all'; this.marketingCampaignPage = 1; },
    paidChannel(channel) { this.marketingCampaignSetChannel(channel); },
    paidIdentityNote() {
      return this.marketingVisao?.pipeline?.identity?.active
        ? 'Indicadores da Matriz: soma dos anúncios identificados como 2W. Campanhas externas ficam fora.'
        : 'Indicadores da Matriz por classificação atual. A separação automática por perfil aguarda a primeira coleta completa.';
    },
    paidUpdated() {
      const at = this.marketingVisao?.connection?.meta_synced_at;
      return at ? `Coleta em ${new Date(at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : 'Coleta ainda não confirmada';
    },
    paidCapi() { return this.marketingVisao?.pipeline?.capi || null; },
    paidCapiStatus() {
      if (this.marketingVisao?.connection?.capi !== 'enabled') return 'Desativado';
      if (!this.marketingVisao?.pipeline?.available) return 'Status indisponível';
      return 'Automático';
    },
    paidCapiCount(kind) {
      if (!this.marketingVisao?.pipeline?.available) return '—';
      const c = this.paidCapi();
      return this.paidNumber(kind === 'failed' ? (c?.failed || 0) + (c?.dead_letter || 0) : c?.[kind]);
    },
    paidAlerts() {
      const rows = [...(this.marketingVisao?.alerts || [])];
      const identity = this.marketingVisao?.pipeline?.identity;
      if (identity?.pending_ads > 0) rows.push({ id: 'identity-pending', severity: 'attention', title: identity.pending_ads + ' anúncio(s) com identidade não confirmada', detail: 'Fora da soma da 2W. Confira o perfil do anúncio e refaça a coleta.', target: 'integracoes' });
      const c = this.paidCapi();
      if (c?.failed || c?.dead_letter) rows.push({ id: 'capi-failures', severity: 'high', title: 'Conversões com falha de envio', detail: `${c.failed + c.dead_letter} evento(s) precisam de revisão.`, target: 'integracoes' });
      else if (c?.pending) rows.push({ id: 'capi-queue', severity: 'info', title: `${c.pending} conversão(ões) na fila`, detail: 'Acompanhe o envio automático à Meta.', target: 'integracoes' });
      return rows;
    },
    paidOpenCampaign(row) { this.marketingTab = 'campanhas'; void this.openMarketingCampaignDetail(row); },
    paidOpenAds() {
      this.marketingSetTab('criativos');
      this.$nextTick(() => document.querySelector('[data-marketing-creatives-screen]')?.scrollIntoView({ block: 'start' }));
    },
    async paidCompare(selectedIds = null, data = null) {
      this.paidCompareData = data;
      compareTrigger = document.activeElement;
      this.paidCompareOpen = true;
      this.$nextTick(() => document.querySelector('.paid-modal [aria-label="Fechar comparação"]')?.focus());
      if (!data && !Array.isArray(selectedIds)) await this.loadMarketingCreatives();
      const rows = this.paidCompareOptions();
      this.paidCompareIds = Array.isArray(selectedIds)
        ? selectedIds.filter(id => rows.some(row => row.id === id)).slice(0, 3)
        : rows.slice(0, 3).map(row => row.id);
    },
    paidCloseCompare() {
      this.paidCompareOpen = false;
      this.$nextTick(() => compareTrigger?.focus());
    },
    paidCompareKeydown(event) {
      if (event.key !== 'Tab') return;
      const nodes = [...event.currentTarget.querySelectorAll('button:not([disabled]),input:not([disabled])')];
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    },
    paidCompareRange() {
      const period = this.paidCompareData?.period;
      return period ? `${this.marketingDateLabel(period.since)} — ${this.marketingDateLabel(period.until)}` : this.marketingCreativeRange();
    },
    paidCompareOptions() { return ((this.paidCompareData || this.marketingCreativesData)?.creatives || []).filter(row => row.scope === 'matrix'); },
    paidCompared() { return this.paidCompareOptions().filter(row => this.paidCompareIds.includes(row.id)); },
    paidToggleCompare(id) {
      if (this.paidCompareIds.includes(id)) this.paidCompareIds = this.paidCompareIds.filter(value => value !== id);
      else if (this.paidCompareIds.length < 3) this.paidCompareIds = [...this.paidCompareIds, id];
    },
    paidExport() {
      const rows = this.paidRows();
      if (!rows.length) return;
      const escape = value => `"${String(value ?? '').replace(/^[=+@\-\t\r]/, "' $&").replaceAll('"', '""')}"`;
      const cells = [['Campanha', 'Escopo', 'Investimento', 'Conversas', 'Vendas atribuídas', 'Receita atribuída', 'Resultado após mídia', 'Impressões', 'Cliques'],
        ...rows.map(r => [r.name, this.marketingCampaignScopeLabel(r.scope), r.investment, r.conversations, r.attributed_sales, r.attributed_revenue, r.profit, r.impressions, r.clicks])];
      const url = URL.createObjectURL(new Blob(['\uFEFF' + cells.map(row => row.map(escape).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `campanhas-${this.marketingPeriod}-${this.paidScope}.csv`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
};
