// Marketing — gráfico diário de investimento e conversas, isolado do estado da visão.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};

window.PAINEL_MODULES.marketingChart = function () {
  return {
    renderMarketingChart() {
      const canvas = document.getElementById('chartMarketingRhythm');
      if (!canvas || typeof Chart === 'undefined') return;
      if (window._marketingRhythmChart) window._marketingRhythmChart.destroy();
      const rows = this.marketingVisao?.series || [];
      if (!rows.length) return;
      const safe = (value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
      };
      window._marketingRhythmChart = new Chart(canvas, {
        type: 'line',
        data: {
          labels: rows.map((row) => this.marketingDateLabel(row.date)),
          datasets: [
            {
              label: 'Investimento (R$)',
              data: rows.map((row) => safe(row.spend)),
              yAxisID: 'investment',
              borderColor: '#047857',
              backgroundColor: 'rgba(16,185,129,0.12)',
              borderWidth: 2.5,
              tension: 0.28,
              fill: true,
              pointRadius: 2.5,
              pointBackgroundColor: '#047857',
              pointBorderColor: '#047857',
              pointBorderWidth: 1,
            },
            {
              label: 'Conversas',
              data: rows.map((row) => safe(row.conversations)),
              yAxisID: 'conversations',
              borderColor: '#34d399',
              borderDash: [6, 5],
              borderWidth: 2,
              tension: 0.28,
              pointRadius: 2,
              pointBackgroundColor: '#34d399',
              fill: false,
            },
          ],
        },
        options: {
          maintainAspectRatio: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              titleFont: { size: 11 },
              bodyFont: { size: 12, weight: '600' },
              callbacks: {
                label: (context) => context.dataset.yAxisID === 'investment'
                  ? `Investimento: ${Number(context.parsed.y || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`
                  : `Conversas: ${Number(context.parsed.y || 0).toLocaleString('pt-BR')}`,
              },
            },
          },
          scales: {
            investment: {
              beginAtZero: true,
              position: 'left',
              grid: { color: '#e5e7eb' },
              ticks: {
                color: '#64748b',
                font: { size: 10 },
                callback: (value) => `R$ ${Number(value).toLocaleString('pt-BR')}`,
              },
              border: { display: false },
            },
            conversations: {
              beginAtZero: true,
              position: 'right',
              grid: { drawOnChartArea: false },
              ticks: { color: '#059669', font: { size: 10 }, precision: 0 },
              border: { display: false },
            },
            x: {
              grid: { display: false },
              ticks: {
                autoSkip: true,
                maxTicksLimit: 7,
                maxRotation: 0,
                color: '#64748b',
                font: { size: 10 },
              },
              border: { display: false },
            },
          },
        },
      });
    },
  };
};
