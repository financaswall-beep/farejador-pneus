// Valores, diferenças e gráfico. Custos e resultados vêm do motor financeiro existente.
window.PAINEL_MODULES.marketingCompareView = function () {
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const ratio = (a, b, multiplier = 1) => number(a) != null && number(b) > 0 ? a / b * multiplier : null;
  return {
    pcNumber(value) { return number(value) == null ? '—' : value.toLocaleString('pt-BR', { maximumFractionDigits: 2 }); },
    pcMoney(value, currency = 'BRL') { return this.marketingCreativeMoney(Object.is(value, -0) ? 0 : number(value), currency); },
    pcCost(side, field) {
      const detail = this.pcDetails[this.paidCompareIds[side]];
      return this.pcLoading || this.pcError ? null : number(detail?.financial?.[field]);
    },
    pcRows() {
      const ads = [this.pcAd(0), this.pcAd(1)];
      const row = (label, getter, format = 'number') => ({ label, values: ads.map((ad, side) => {
        const value = ad ? getter(ad, side) : null;
        return format === 'media' ? this.pcMoney(value, ad?.currency) : format === 'money' ? this.pcMoney(value)
          : format === 'percent' ? number(value) == null ? '—' : this.pcNumber(value) + '%' : this.pcNumber(value);
      }) });
      return [
        { group: 'Entrega na Meta' },
        row('Investimento', ad => ad.investment, 'media'),
        row('Impressões', ad => ad.impressions),
        { label: 'Cliques · CTR', values: ads.map(ad => ad ? `${this.pcNumber(ad.clicks)} · ${ad.impressions > 0 ? this.pcNumber(ratio(ad.clicks, ad.impressions, 100)) + '%' : '—'}` : '—') },
        row('Conversas iniciadas', ad => ad.conversations),
        row('Custo por conversa', ad => ad.cost_per_conversation, 'media'),
        { group: 'Vendas e resultado no Farejador' },
        row('Conversas identificadas', ad => ad.tracked),
        row('Vendas atribuídas', ad => ad.attributed_sales),
        row('Receita atribuída', ad => ad.attributed_revenue, 'money'),
        row('Custo dos pneus', (_ad, side) => { const cost = this.pcCost(side, 'product_cost'); return cost == null ? null : -cost; }, 'money'),
        row('Repasses e operação', (_ad, side) => { const cost = this.pcCost(side, 'operation_cost'); return cost == null ? null : -cost; }, 'money'),
        row('Mídia por venda', ad => ratio(ad.investment, ad.attributed_sales), 'media'),
        row('ROAS', ad => ad.currency === 'BRL' ? ratio(ad.attributed_revenue, ad.investment) : null),
        { ...row('Resultado após mídia', ad => ad.net_after_media, 'money'), result: true },
      ];
    },
    pcObservations() {
      const a = this.pcAd(0), b = this.pcAd(1), notes = [];
      if (!a || !b) return [{ icon: 'mouse-pointer-click', text: 'Selecione dois anúncios para comparar os resultados.' }];
      if (number(a.attributed_sales) != null && number(b.attributed_sales) != null) {
        const delta = a.attributed_sales - b.attributed_sales;
        notes.push({ icon: 'chart-no-axes-column-increasing', text: delta === 0
          ? `Mesmo número de vendas: ${this.pcNumber(a.attributed_sales)} em cada anúncio.`
          : `${delta > 0 ? 'A' : 'B'} tem ${this.pcNumber(Math.abs(delta))} venda(s) atribuída(s) a mais.` });
      }
      if (number(a.net_after_media) != null && number(b.net_after_media) != null && a.currency === b.currency) {
        const delta = Math.round((a.net_after_media - b.net_after_media) * 100) / 100;
        notes.push({ icon: 'coins', text: delta === 0 ? 'Mesmo resultado após mídia nos dois anúncios.'
          : `${delta > 0 ? 'A' : 'B'} tem ${this.pcMoney(Math.abs(delta))} a mais de resultado após mídia.` });
      }
      if (a.currency !== b.currency) notes.push({ icon: 'info', text: 'Moedas diferentes: custos não são comparáveis diretamente.' });
      if (!notes.length) notes.push({ icon: 'info', text: 'Resultado comercial ainda indisponível para comparar. Confira a atribuição e os custos.' });
      return notes;
    },
    pcHighlight(side) {
      const a = this.pcAd(side), b = this.pcAd(1 - side);
      return number(a?.net_after_media) != null && number(b?.net_after_media) != null
        && a.currency === b.currency && a.net_after_media > b.net_after_media;
    },
    pcChartComparable() { const ads = this.paidCompared(); return ads.length > 0 && new Set(ads.map(ad => ad.currency)).size === 1; },
    pcDestroyChart() { window._paidComparisonChart?.destroy(); window._paidComparisonChart = null; },
    pcRenderChart() {
      this.pcDestroyChart();
      const period = this.paidCompareData?.period;
      if (!this.paidCompareOpen || this.madId || this.pcLoading || this.pcError || !period || !this.pcChartComparable()) return;
      const canvas = document.getElementById('chartPaidComparison');
      if (!canvas || typeof Chart === 'undefined') return;
      const dates = [], ads = [this.pcAd(0), this.pcAd(1)];
      for (let day = new Date(`${period.since}T12:00:00Z`); day.toISOString().slice(0, 10) <= period.until; day.setUTCDate(day.getUTCDate() + 1)) dates.push(day.toISOString().slice(0, 10));
      window._paidComparisonChart = new Chart(canvas, {
        type: 'line', data: { labels: dates.map(date => this.marketingDateLabel(date)),
          datasets: ads.flatMap((ad, side) => {
            if (!ad) return [];
            const daily = new Map((ad.series || []).map(day => [day.date, day]));
            return [{ label: `Anúncio ${side === 0 ? 'A' : 'B'} (média: ${this.pcMoney(ad.cost_per_conversation, ad.currency)})`,
              data: dates.map(date => { const day = daily.get(date); return day ? ratio(day.spend, day.conversations) : null; }),
              borderColor: side === 0 ? '#006b58' : '#526b90', backgroundColor: side === 0 ? '#006b58' : '#526b90',
              borderWidth: 2, pointRadius: 3, tension: .15, spanGaps: false }];
          }) },
        options: { maintainAspectRatio: false, animation: false, interaction: { intersect: false, mode: 'index' },
          plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, pointStyleWidth: 8, usePointStyle: true, font: { size: 11 } } },
            tooltip: { callbacks: { label: item => `${item.dataset.label.split(' (')[0]}: ${this.pcMoney(item.parsed.y, ads.find(Boolean).currency)}` } } },
          scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 5, maxRotation: 0, color: '#62728b' } },
            y: { beginAtZero: true, grid: { color: '#ecf0f5' }, ticks: { maxTicksLimit: 4, callback: value => this.pcMoney(value, ads.find(Boolean).currency) } } },
        },
      });
    },
    pcCsv() {
      const ads = [this.pcAd(0), this.pcAd(1)], period = this.paidCompareData?.period;
      const rows = [ ['Comparação de anúncios', 'Anúncio A', 'Anúncio B'],
        ['Anúncio', ...ads.map(ad => ad?.name || '')], ['ID', ...ads.map(ad => ad?.id || '')],
        ['Campanha', ...ads.map(ad => ad?.campaign_name || '')], ['Moeda da mídia', ...ads.map(ad => ad?.currency || '')],
        ['Período', period?.since || '', period?.until || ''],
        ...this.pcRows().map(row => row.group ? [row.group, '', ''] : [row.label, ...row.values]),
      ];
      const cell = value => { const text = String(value ?? ''); return `"${(/^[\s]*[=+@\-]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`; };
      return '\uFEFF' + rows.map(row => row.map(cell).join(';')).join('\r\n');
    },
    pcExport() {
      if (this.pcLoading || this.pcDetailsLoading || this.pcError || this.paidCompared().length < 2) return;
      const period = this.paidCompareData.period, url = URL.createObjectURL(new Blob([this.pcCsv()], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `comparacao-anuncios-${period.since}-${period.until}.csv`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
};
