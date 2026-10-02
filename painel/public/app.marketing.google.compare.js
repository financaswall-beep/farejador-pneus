// Comparação somente de leitura, sobre o relatório Google e o motor financeiro existentes.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingGoogleCompare = function () {
  const known = value => typeof value === 'number' && Number.isFinite(value);
  return {
    googleCompareNotice: '',
    googleCompareOptions() { return this.googleAdsReport?.data?.ads || []; },
    googleCompareAd(side) {
      const ad = this.googleAdById(side === 0 ? this.googleCompareA : this.googleCompareB);
      return ad ? { ...ad, ...this.googleResult(ad) } : null;
    },
    googleCompareValid() {
      return !!(this.googleCompareAd(0) && this.googleCompareAd(1) && this.googleCompareA !== this.googleCompareB);
    },
    googleCompareNumber(value) {
      return known(value) ? value.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : '—';
    },
    googleCompareAverage(side) {
      const ad = this.googleCompareAd(side);
      return known(ad?.investment) && ad?.clicks > 0 ? ad.investment / ad.clicks : null;
    },
    googleCompareStatus(side) {
      return { ENABLED: 'Ativo', PAUSED: 'Pausado', REMOVED: 'Removido' }[this.googleCompareAd(side)?.status] || 'Não informado';
    },
    googleCompareRange() {
      const period = this.googleAdsReport?.data?.period;
      const format = date => new Date(date + 'T12:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'UTC' });
      return period ? format(period.since) + ' — ' + format(period.until) : '';
    },
    googleCompareOpen() {
      this.googleCompareNotice = '';
      this.$nextTick(() => {
        lucide.createIcons(); this.renderGoogleCompareChart();
        document.querySelector('[data-google-compare-screen]')?.scrollIntoView({ block: 'start' });
        document.getElementById('google-compare-heading')?.focus({ preventScroll: true });
      });
    },
    googleCompareBack() {
      this.googleCompareDestroyChart(); this.googleCompareNotice = '';
      if (this.googleCampaignReturnId) { this.googleReturnCampaign(); return; }
      this.googleAdsView = 'ads';
      this.$nextTick(() => {
        lucide.createIcons(); document.querySelector('[data-google-ad-gallery]')?.scrollIntoView({ block: 'start' });
      });
    },
    googleCompareSelect(side, id) {
      if (![0, 1].includes(side) || !this.googleAdById(id)) return;
      const key = side === 0 ? 'googleCompareA' : 'googleCompareB';
      const other = side === 0 ? 'googleCompareB' : 'googleCompareA';
      this.googleCompareNotice = '';
      if (this[other] === id) {
        this[other] = this[key];
        this.googleCompareNotice = 'A posição dos anúncios foi trocada para manter dois anúncios diferentes.';
      }
      this[key] = id;
      this.googleAdsSelected = [this.googleCompareA, this.googleCompareB].filter(Boolean);
      this.$nextTick(() => { lucide.createIcons(); this.renderGoogleCompareChart(); });
    },
    googleCompareSwap() {
      if (!this.googleCompareValid()) return;
      [this.googleCompareA, this.googleCompareB] = [this.googleCompareB, this.googleCompareA];
      this.googleAdsSelected = [this.googleCompareA, this.googleCompareB];
      this.googleCompareNotice = '';
      this.$nextTick(() => { lucide.createIcons(); this.renderGoogleCompareChart(); });
    },
    googleCompareViewAd(side) {
      const ad = this.googleCompareAd(side);
      if (ad) this.googleOpenAd(ad.id);
    },
    googleCompareHighlight(side) {
      const ad = this.googleCompareAd(side), other = this.googleCompareAd(1 - side);
      return known(ad?.result) && known(other?.result) && ad.result > other.result;
    },
    googleCompareGroups() {
      if (!this.googleCompareValid()) return [];
      const ads = [this.googleCompareAd(0), this.googleCompareAd(1)];
      const row = (label, getter, type = 'number') => ({ label, values: ads.map((ad, side) => {
        const value = getter(ad, side);
        return type === 'money' ? this.paidMoney(known(value) ? (Object.is(value, -0) ? 0 : value) : null) : this.googleCompareNumber(value);
      }) });
      return [
        { group: 'Entrega no Google', rows: [
          row('Investimento', ad => ad.investment, 'money'),
          row('Impressões', ad => ad.impressions),
          { label: 'Cliques · CTR', values: ads.map(ad => this.googleCompareNumber(ad.clicks) + ' · '
            + (known(ad.ctr) ? this.googleCompareNumber(ad.ctr) + '%' : '—')) },
          row('Custo por clique', (_ad, side) => this.googleCompareAverage(side), 'money'),
          row('CPM', ad => ad.cpm, 'money'),
          row('Conversões Google', ad => ad.conversions),
          row('Valor de conversão Google', ad => ad.conversion_value, 'money'),
        ] },
        { group: 'Vendas e resultado no Farejador', rows: [
          row('Conversas identificadas', ad => ad.tracked_conversations),
          row('Vendas atribuídas', ad => ad.attributed_sales),
          row('Receita atribuída', ad => ad.attributed_revenue, 'money'),
          row('Custo dos pneus / produtos', ad => known(ad.product_cost) ? -ad.product_cost : null, 'money'),
          row('Repasses aos parceiros', ad => known(ad.partner_payout) ? -ad.partner_payout : null, 'money'),
          row('Margem antes da mídia', ad => ad.gross_margin, 'money'),
          row('Mídia por venda', ad => ad.attributed_sales > 0 ? ad.investment / ad.attributed_sales : null, 'money'),
          row('ROAS', ad => ad.roas),
          { ...row('Resultado após mídia', ad => ad.result, 'money'), result: true },
        ] },
      ];
    },
    googleCompareRows() {
      return this.googleCompareGroups().flatMap(group => group.rows.map(row => ({
        ...row, a: row.values[0], b: row.values[1],
      })));
    },
    googleCompareObservations() {
      if (!this.googleCompareValid()) return [];
      const [a, b] = [this.googleCompareAd(0), this.googleCompareAd(1)], notes = [];
      if (known(a.attributed_sales) && known(b.attributed_sales)) {
        const delta = a.attributed_sales - b.attributed_sales;
        notes.push({ icon: 'chart-no-axes-column-increasing', text: delta === 0
          ? 'Mesmo número de vendas: ' + this.googleCompareNumber(a.attributed_sales) + ' em cada anúncio.'
          : (delta > 0 ? 'A' : 'B') + ' tem ' + this.googleCompareNumber(Math.abs(delta)) + ' venda(s) atribuída(s) a mais.' });
      }
      if (known(a.result) && known(b.result)) {
        const delta = Math.round((a.result - b.result) * 100) / 100;
        notes.push({ icon: 'coins', text: delta === 0 ? 'Mesmo resultado após mídia nos dois anúncios.'
          : (delta > 0 ? 'A' : 'B') + ' tem ' + this.paidMoney(Math.abs(delta)) + ' a mais de resultado após mídia.' });
      } else {
        notes.push({ icon: 'info', text: 'O resultado financeiro aguarda apuração ou custos completos. Não há comparação de resultado disponível.' });
      }
      return notes;
    },
    googleCompareSeries() {
      const period = this.googleAdsReport?.data?.period;
      if (!period || !this.googleCompareValid()) return [];
      const days = [0, 1].map(side => new Map((this.googleCompareAd(side).daily || []).map(day => [day.date, day])));
      const rows = [];
      for (let at = Date.parse(period.since + 'T12:00:00Z'), end = Date.parse(period.until + 'T12:00:00Z'); at <= end; at += 86400000) {
        const date = new Date(at).toISOString().slice(0, 10);
        rows.push({ date, values: days.map(map => {
          const day = map.get(date), cost = day?.cost_micros == null ? NaN : Number(day.cost_micros);
          return day?.clicks > 0 && Number.isFinite(cost) ? cost / 1e6 / day.clicks : null;
        }) });
      }
      return rows;
    },
    googleCompareHasPoints() { return this.googleCompareSeries().some(row => row.values.some(known)); },
    googleCompareDestroyChart() {
      window._googleComparisonChart?.destroy(); window._googleComparisonChart = null;
    },
    renderGoogleCompareChart() {
      this.googleCompareDestroyChart();
      if (this.marketingCampaignChannel !== 'google' || this.googleAdsView !== 'compare'
        || this.currentPage !== 'marketing' || this.marketingTab !== 'visao'
        || this.googleAdsLoading || !this.googleCompareValid()) return;
      const canvas = document.getElementById('chartGoogleComparison'), rows = this.googleCompareSeries();
      if (!canvas || typeof Chart === 'undefined' || !this.googleCompareHasPoints()) return;
      window._googleComparisonChart = new Chart(canvas, {
        type: 'line', data: { labels: rows.map(row => row.date), datasets: [0, 1].map(side => ({
          label: 'Anúncio ' + (side === 0 ? 'A' : 'B') + ' · média ' + this.paidMoney(this.googleCompareAverage(side)),
          data: rows.map(row => row.values[side]), borderColor: side === 0 ? '#006b58' : '#526b90',
          backgroundColor: side === 0 ? '#006b58' : '#526b90', borderWidth: 2, pointRadius: 3,
          tension: .15, spanGaps: false,
        })) },
        options: { responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { position: 'top', align: 'end', labels: { usePointStyle: true,
            boxWidth: 8, boxHeight: 8, pointStyleWidth: 8, font: { size: 11 } } },
            tooltip: { callbacks: { label: item => item.dataset.label.split(' · ')[0] + ': ' + this.paidMoney(item.raw) } } },
          scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 5, maxRotation: 0,
            callback: function (index) { const date = this.getLabelForValue(index); return date.slice(8, 10) + '/' + date.slice(5, 7); } } },
            y: { beginAtZero: true, grid: { color: '#ecf0f5' }, ticks: { maxTicksLimit: 4, callback: value => this.paidMoney(value) } } },
        },
      });
    },
    googleCompareExport() {
      if (this.googleAdsLoading || !this.googleCompareValid()) return;
      const ads = [this.googleCompareAd(0), this.googleCompareAd(1)], period = this.googleAdsReport.data.period;
      this.googleExportCells([
        ['Comparação de anúncios Google Ads', 'Anúncio A', 'Anúncio B'],
        ['Anúncio', ...ads.map(ad => ad.name)], ['ID anúncio', ...ads.map(ad => ad.ad_id)],
        ['ID grupo', ...ads.map(ad => ad.ad_group_id)], ['Campanha', ...ads.map(ad => ad.campaign_name)],
        ['Período', period?.since || '', period?.until || ''], ['Escopo', 'Matriz', 'Matriz'],
        ...this.googleCompareGroups().flatMap(group => [[group.group, '', ''], ...group.rows.map(row => [row.label, ...row.values])]),
      ]);
    },
  };
};
