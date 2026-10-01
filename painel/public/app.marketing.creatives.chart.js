window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingCreativeChart = function () {
  return {
    destroyMarketingCreativeChart() {
      if (window._marketingCreativeChart) { window._marketingCreativeChart.destroy(); window._marketingCreativeChart = null; }
    },
    renderMarketingCreativeChart() {
      this.destroyMarketingCreativeChart();
      if (this.currentPage !== 'marketing') return;
      const detail = Boolean(this.madId);
      if (detail ? this.madLoading || this.madTab !== 'resultado'
        : this.marketingTab !== 'criativos' || this.marketingCreativesLoading || !this.marketingCreativeAnalysisOpen) return;
      const row = detail ? this.madData?.ad : this.marketingCreativeSelected();
      const canvas = document.getElementById(detail ? 'chartMarketingAdDetailCost' : 'chartMarketingCreativeCost');
      if (!row || !canvas || typeof Chart === 'undefined') return;
      const period = detail ? this.madData.period : this.marketingCreativesData.period;
      const byDate = new Map(row.series.map((day) => [day.date, day]));
      const dates = [];
      for (let d = new Date(`${period.since}T12:00:00Z`); d.toISOString().slice(0, 10) <= period.until; d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));
      const average = detail ? this.madData.campaign.cost_per_conversation : this.marketingCreativeMetrics().cost;
      window._marketingCreativeChart = new Chart(canvas, {
        type: 'line',
        data: { labels: dates.map((date) => this.marketingDateLabel(date)), datasets: [
          { label: row.name, data: dates.map((date) => {
            const day = byDate.get(date); return day?.conversations > 0 ? day.spend / day.conversations : null;
          }), borderColor: '#00866c', backgroundColor: '#00866c12', fill: true, borderWidth: 2.5, tension: 0.15, pointRadius: 3, spanGaps: false },
          { label: detail ? 'Média da campanha' : 'Média dos filtros', data: dates.map(() => average), borderColor: '#899caf', borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0 },
        ] },
        options: { maintainAspectRatio: false, animation: false, interaction: { intersect: false, mode: 'index' },
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
            tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${this.marketingCreativeMoney(item.parsed.y, row.currency)}` } } },
          scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0, color: '#64748b', font: { size: 10 } } },
            y: { beginAtZero: true, grid: { color: '#edf1f4' }, ticks: { maxTicksLimit: 5, font: { size: 10 }, callback: (value) => this.marketingCreativeMoney(value, row.currency) } } },
        },
      });
    },
  };
};
