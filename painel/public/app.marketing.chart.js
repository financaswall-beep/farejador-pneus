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
        type: 'bar',
        data: {
          labels: rows.map((row) => this.marketingDateLabel(row.date)),
          datasets: [
            {
              label: 'Investimento (R$)',
              type: 'bar',
              data: rows.map((row) => safe(row.spend)),
              yAxisID: 'investment',
              borderColor: '#99d9c6',
              backgroundColor: 'rgba(115,199,172,0.65)',
              borderWidth: 0,
              borderRadius: 3,
              maxBarThickness: 20,
              tension: 0.28,
              fill: true,
              pointRadius: 2.5,
              pointBackgroundColor: '#047857',
              pointBorderColor: '#047857',
              pointBorderWidth: 1,
            },
            {
              label: 'Conversas',
              type: 'line',
              data: rows.map((row) => safe(row.conversations)),
              yAxisID: 'conversations',
              borderColor: '#005e4c',
              borderWidth: 2,
              tension: 0.28,
              pointRadius: 3,
              pointBackgroundColor: '#005e4c',
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
