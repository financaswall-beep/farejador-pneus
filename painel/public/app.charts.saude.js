// Obra 300 (2026-07-05): fatia do painel da MATRIZ — gráficos: origem, saúde, compras, estoque parado, margem.
// VERBATIM das linhas 2618-2851 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.chartsSaude = function () {
  return {
    renderRedeOrigemChart() {
      const ctx = document.getElementById('chartRedeOrigem');
      if (!ctx) return;
      if (window._redeOrigemChart) window._redeOrigemChart.destroy();

      const total2w = this.redeTotal2w();
      const totalPorta = this.redeTotalPorta();

      window._redeOrigemChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: ['2W', 'Porta'],
          datasets: [{
            data: [total2w, totalPorta],
            backgroundColor: ['#047857', '#6ee7b7'],
            borderWidth: 0,
            hoverOffset: 4,
          }],
        },
        options: {
          maintainAspectRatio: false,
          cutout: '68%',
          plugins: {
            legend: {
              position: 'bottom',
              labels: { boxWidth: 10, usePointStyle: true, color: '#6b7280', font: { size: 11 } },
            },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              callbacks: {
                label: (ctx) => `${ctx.label}: ${Number(ctx.parsed || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`,
              },
            },
          },
        },
      });
    },

    renderRedeSaudeChart() {
      const ctx = document.getElementById('chartRedeSaude');
      if (!ctx) return;
      if (window._redeSaudeChart) window._redeSaudeChart.destroy();

      const parceiros = this.rankingSaude();

      window._redeSaudeChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: parceiros.map((p) => p.nome.replace('Borracharia ', '').replace('Pneus ', '')),
          datasets: [{
            data: parceiros.map((p) => this.saudeScore(p)),
            backgroundColor: parceiros.map((p) => {
              const score = this.saudeScore(p);
              if (score >= 80) return '#10b981';
              if (score >= 60) return '#f59e0b';
              return '#f43f5e';
            }),
            borderRadius: 6,
            barThickness: 16,
          }],
        },
        options: {
          indexAxis: 'y',
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              callbacks: { label: (ctx) => `${ctx.parsed.x} pontos` },
            },
          },
          scales: {
            x: {
              min: 0,
              max: 100,
              grid: { color: '#f3f4f6' },
              ticks: { color: '#9ca3af', font: { size: 11 } },
              border: { display: false },
            },
            y: {
              grid: { display: false },
              ticks: { color: '#6b7280', font: { size: 11 } },
              border: { display: false },
            },
          },
        },
      });
    },

    renderRedeComprasChart() {
      const ctx = document.getElementById('chartRedeCompras');
      if (!ctx) return;
      if (window._redeComprasChart) window._redeComprasChart.destroy();

      const parceiros = [...this.parceirosRede]
        .sort((a, b) => Number(b.comprasPneus || 0) - Number(a.comprasPneus || 0));

      window._redeComprasChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: parceiros.map((p) => p.nome.replace('Borracharia ', '').replace('Pneus ', '')),
          datasets: [{
            data: parceiros.map((p) => Number(p.comprasPneus || 0)),
            backgroundColor: parceiros.map((p, i) => i === 0 ? '#047857' : '#a7f3d0'),
            borderRadius: 6,
            barThickness: 16,
          }],
        },
        options: {
          indexAxis: 'y',
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              callbacks: {
                label: (ctx) => Number(ctx.parsed.x || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
              },
            },
          },
          scales: {
            x: {
              grid: { color: '#f3f4f6' },
              ticks: {
                color: '#9ca3af',
                font: { size: 11 },
                callback: (value) => 'R$ ' + Number(value).toLocaleString('pt-BR'),
              },
              border: { display: false },
            },
            y: {
              grid: { display: false },
              ticks: { color: '#6b7280', font: { size: 11 } },
              border: { display: false },
            },
          },
        },
      });
    },

    renderEstoqueParadoChart() {
      const ctx = document.getElementById('chartEstoqueParado');
      if (!ctx) return;
      if (window._estoqueParadoChart) window._estoqueParadoChart.destroy();

      const parceiros = [...this.parceirosRede]
        .sort((a, b) => (b.estoqueItens || []).length - (a.estoqueItens || []).length);
      const maxCount = (parceiros[0]?.estoqueItens || []).length;

      window._estoqueParadoChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: parceiros.map((p) => p.nome.replace('Borracharia ', '').replace('Pneus ', '')),
          datasets: [{
            data: parceiros.map((p) => (p.estoqueItens || []).length),
            backgroundColor: parceiros.map((p, i) => i === 0 ? '#047857' : '#d1fae5'),
            borderRadius: 4,
            barThickness: 8,
          }],
        },
        options: {
          indexAxis: 'y',
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 8,
              callbacks: {
                label: (ctx) => `${ctx.parsed.x} itens cadastrados`,
              },
            },
          },
          scales: {
            x: { display: false, max: Math.max(maxCount, 1) },
            y: {
              grid: { display: false },
              ticks: { color: '#6b7280', font: { size: 10 } },
              border: { display: false },
            },
          },
        },
      });
    },

    renderMargemChart() {
      const ctx = document.getElementById('chartMargem');
      if (!ctx) return;
      if (window._margemChart) window._margemChart.destroy();

      const parceiros = [...this.parceirosRede]
        .filter((p) => p.margem && p.margem !== '-')
        .map((p) => ({ nome: p.nome, valor: Number(String(p.margem).replace('%', '')) || 0 }))
        .sort((a, b) => b.valor - a.valor);

      window._margemChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: parceiros.map((p) => p.nome.replace('Borracharia ', '').replace('Pneus ', '')),
          datasets: [{
            data: parceiros.map((p) => p.valor),
            backgroundColor: parceiros.map((p, i) => i === 0 ? '#10b981' : '#e5e7eb'),
            borderRadius: 4,
            barThickness: 8,
          }],
        },
        options: {
          indexAxis: 'y',
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 8,
              callbacks: {
                label: (ctx) => `${ctx.parsed.x}% de margem`,
              },
            },
          },
          scales: {
            x: { display: false, suggestedMax: 50 },
            y: {
              grid: { display: false },
              ticks: { color: '#6b7280', font: { size: 10 } },
              border: { display: false },
            },
          },
        },
      });
    },

  };
};
