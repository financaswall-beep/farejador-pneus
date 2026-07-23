// Operação e saúde aprovada em 23/07 e promovida para a tela padrão da Rede.
// Nenhuma fonte paralela é criada: todos os blocos derivam de parceirosRede
// e do mesmo livro de comissões usado pela tela anterior.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.redeOperacao = function () {
  return {
    redeOperacaoLegadaAtiva() {
      return new URLSearchParams(window.location.search).get('redeLegacy') === '1';
    },

    redeUltimaVendaLabel(parceiro) {
      const values = Array.isArray(parceiro?.serieVendas) ? parceiro.serieVendas : [];
      for (let index = values.length - 1; index >= 0; index -= 1) {
        if (Number(values[index] || 0) <= 0) continue;
        const dias = values.length - index - 1;
        if (dias === 0) return 'Hoje';
        if (dias === 1) return 'Ontem';
        return `há ${dias} dias`;
      }
      return 'Sem venda';
    },

    redeOperacaoCommissionRows() {
      if (this.livroComissaoOn()) {
        return [...(this.comissoes?.partners || [])]
          .filter((row) => Number(row.open_total || 0) > 0)
          .sort((a, b) => Number(b.open_total || 0) - Number(a.open_total || 0))
          .slice(0, 5)
          .map((row) => {
            const parceiro = this.parceirosRede.find((item) => item.partnerId === row.partner_id);
            return { ...row, ultimaVenda: this.redeUltimaVendaLabel(parceiro) };
          });
      }
      return this.parceirosRede
        .filter((parceiro) => Number(parceiro.comissaoDevida || 0) > 0)
        .sort((a, b) => Number(b.comissaoDevida || 0) - Number(a.comissaoDevida || 0))
        .slice(0, 5)
        .map((parceiro) => ({
          partner_id: parceiro.partnerId,
          partner_name: parceiro.nome,
          open_total: Number(parceiro.comissaoDevida || 0),
          open_count: 0,
          whatsapp_phone: parceiro.whatsapp,
          ultimaVenda: this.redeUltimaVendaLabel(parceiro),
        }));
    },

    redeSaudeResumo() {
      const scores = this.parceirosRede.map((parceiro) => this.saudeScore(parceiro));
      const total = scores.length;
      return {
        media: total > 0 ? Math.round(scores.reduce((sum, score) => sum + score, 0) / total) : 0,
        saudavel: scores.filter((score) => score >= 80).length,
        atencao: scores.filter((score) => score >= 60 && score < 80).length,
        critico: scores.filter((score) => score < 60).length,
      };
    },

    redeSaudeSituacao(parceiro) {
      const score = this.saudeScore(parceiro);
      if (score >= 80) {
        return {
          label: 'Saudável',
          badge: 'bg-emerald-100 text-emerald-800 border-emerald-200',
          bar: 'bg-emerald-700',
          icon: 'circle-check',
        };
      }
      if (score >= 60) {
        return {
          label: 'Atenção',
          badge: 'bg-lime-100 text-emerald-900 border-lime-200',
          bar: 'bg-lime-500',
          icon: 'triangle-alert',
        };
      }
      return {
        label: 'Crítico',
        badge: 'bg-emerald-950 text-white border-emerald-950',
        bar: 'bg-emerald-950',
        icon: 'shield-alert',
      };
    },

    redeCausaPrincipal(parceiro) {
      if (parceiro?.custoPendente) return 'Custo histórico pendente';
      if (Number(parceiro?.estoqueBaixo || 0) > 0) return 'Estoque crítico';
      if (this.parceiroVendaHojeValor(parceiro) <= 0) return 'Sem venda hoje';
      if (parceiro?.diasSemAtualizar === null || Number(parceiro?.diasSemAtualizar) >= 4) return 'Sem atualização';
      if (!parceiro?.custoPendente && Number(parceiro?.lucroEstimado || 0) < 0) return 'Resultado negativo';
      if (Number(parceiro?.percentual2w || 0) >= 70) return 'Alta dependência 2W';
      return 'Operação estável';
    },

    redeUnidadesEmFoco() {
      return [...this.parceirosRede]
        .sort((a, b) => this.saudeScore(a) - this.saudeScore(b))
        .slice(0, 3);
    },

    redeOperacaoAlertas() {
      return [
        {
          label: 'Custo pendente',
          icon: 'badge-dollar-sign',
          filter: 'alerta',
          count: this.parceirosRede.reduce((sum, parceiro) => sum + Number(parceiro.custoPendenteItens || 0), 0),
        },
        {
          label: 'Estoque crítico',
          icon: 'package-x',
          filter: 'alerta',
          count: this.parceirosRede.reduce((sum, parceiro) => sum + Number(parceiro.estoqueBaixo || 0), 0),
        },
        { label: 'Sem venda hoje', icon: 'trending-down', filter: 'sem_venda', count: this.unidadesSemVendaHoje().length },
        { label: 'Sem atualização', icon: 'refresh-cw', filter: 'sem_atualizacao', count: this.unidadesSemAtualizacao().length },
      ];
    },

    redeDependenciaSituacao(parceiro) {
      const percentual = Number(parceiro?.percentual2w || 0);
      if (percentual >= 70) return 'Alta';
      if (percentual >= 50) return 'Média';
      return 'Baixa';
    },

    parceiroPedidoHojeValor(parceiro) {
      const values = Array.isArray(parceiro?.seriePedidos) ? parceiro.seriePedidos : [];
      return Number(values.length > 0 ? values[values.length - 1] : 0);
    },

    redeVendasHojeRanking() {
      return [...this.parceirosRede]
        .sort((a, b) => this.parceiroVendaHojeValor(b) - this.parceiroVendaHojeValor(a))
        .slice(0, 5);
    },

    redeVendaHojeTotal() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + this.parceiroVendaHojeValor(parceiro), 0);
    },

    redePedidosHojeTotal() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + this.parceiroPedidoHojeValor(parceiro), 0);
    },

    redeVendaHojeCobertura() {
      const total = this.parceirosRede.length;
      if (total === 0) return 0;
      return Math.round(((total - this.unidadesSemVendaHoje().length) / total) * 100);
    },
  };
};
