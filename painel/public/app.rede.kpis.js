// Obra 300 (2026-07-05): fatia do painel da MATRIZ — derivadas da Rede: metas, séries, totais, rankings, alertas.
// VERBATIM das linhas 263-455 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.redeKpis = function () {
  return {
    redeTotalVendasValor() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + Number(parceiro.vendasValor || 0), 0);
    },

    redePeriodLabel() {
      return this.redePeriods.find((period) => period.id === this.redePeriod)?.label || 'Mês atual';
    },

    redeSeriesLabels() {
      const len = Math.max(this.redeSalesSeries().length, this.redeOrderSeries().length, 1);
      if (len === 1) return ['Hoje'];
      return Array.from({ length: len }, (_, index) => {
        const remaining = len - index - 1;
        if (remaining === 0) return 'Hoje';
        if (remaining === 1) return 'Ontem';
        return `D-${remaining}`;
      });
    },

    redeGoalDaily() {
      const len = Math.max(this.redeSalesSeries().length, 1);
      return Number(this.redeSalesGoal || 0) / len;
    },

    redeGoalProgress() {
      const goal = Number(this.redeSalesGoal || 0);
      if (goal <= 0) return 0;
      return Math.min(100, Math.round((this.redeTotalVendasValor() / goal) * 100));
    },

    redeGoalRemaining() {
      return Math.max(0, Number(this.redeSalesGoal || 0) - this.redeTotalVendasValor());
    },

    redeTotalVendas() {
      return this.formatCurrency(this.redeTotalVendasValor());
    },

    // O servidor manda a série do PERÍODO inteiro (mês = até 31 pontos, hoje por último).
    // O gráfico mostra os ÚLTIMOS 7 dias, alinhados pelo FIM — somar os 7 PRIMEIROS
    // escondia a venda de hoje e rotulava o dia 7 do mês de "Hoje" (auditoria 07-10).
    redeSalesSeries() {
      const maxLen = Math.max(0, ...this.parceirosRede.map((p) => (Array.isArray(p.serieVendas) ? p.serieVendas.length : 0)));
      const len = Math.min(7, maxLen) || 7;
      const series = new Array(len).fill(0);
      for (const parceiro of this.parceirosRede) {
        const values = (Array.isArray(parceiro.serieVendas) ? parceiro.serieVendas : []).slice(-len);
        const offset = len - values.length;
        for (let i = 0; i < values.length; i += 1) {
          series[offset + i] += Number(values[i] || 0);
        }
      }
      return series;
    },

    redeOrderSeries() {
      const maxLen = Math.max(0, ...this.parceirosRede.map((p) => (Array.isArray(p.seriePedidos) ? p.seriePedidos.length : 0)));
      const len = Math.min(7, maxLen) || 7;
      const series = new Array(len).fill(0);
      for (const parceiro of this.parceirosRede) {
        const values = (Array.isArray(parceiro.seriePedidos) ? parceiro.seriePedidos : []).slice(-len);
        const offset = len - values.length;
        for (let i = 0; i < values.length; i += 1) {
          series[offset + i] += Number(values[i] || 0);
        }
      }
      return series;
    },

    redeTotalPedidos() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + Number(parceiro.pedidos || 0), 0);
    },

    redeTicketMedio() {
      const pedidos = this.redeTotalPedidos();
      return pedidos > 0 ? this.redeTotalVendasValor() / pedidos : 0;
    },

    redeTopUnidades() {
      return [...this.parceirosRede]
        .filter((parceiro) => Number(parceiro.vendasValor || 0) > 0)
        .sort((a, b) => Number(b.vendasValor || 0) - Number(a.vendasValor || 0))
        .slice(0, 3);
    },

    redeParticipacaoVendas(parceiro) {
      const total = this.redeTotalVendasValor();
      if (total <= 0) return '0%';
      const percentual = (Number(parceiro?.vendasValor || 0) / total) * 100;
      return percentual.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
    },

    redeTotal2w() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + Number(parceiro.vendas2w || 0), 0);
    },

    redeTotalPorta() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + Number(parceiro.vendasPorta || 0), 0);
    },

    redeOrigemTotal() {
      return this.redeTotal2w() + this.redeTotalPorta();
    },

    redeOrigemPercent(valor) {
      const total = this.redeOrigemTotal();
      return total > 0 ? Math.round((Number(valor || 0) / total) * 100) : 0;
    },

    redeTotalComissao() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + Number(parceiro.comissaoDevida || 0), 0);
    },

    redeTotalMensalidade() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + Number(parceiro.mensalidadeDevida || 0), 0);
    },

    redeTotalDevido() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + Number(parceiro.devidoMatriz || 0), 0);
    },

    // Livro de comissões (0118) LIGADO → "a receber" = lançamentos EM ABERTO no livro
    // (o Recebi desconta na hora; frete fora; sem recorte de período). Desligado →
    // estimativa antiga (% × vendas 2W do período). Dono apontou o furo em 07-02:
    // quitou no livro e o card antigo continuava cobrando.
    livroComissaoOn() {
      return !!(this.comissoes && this.comissoes.enabled);
    },
    redeComissaoAReceber() {
      return this.livroComissaoOn() ? Number(this.comissoes.total_aberto || 0) : this.redeTotalComissao();
    },
    redeAReceberTotal() {
      return this.redeTotalMensalidade() + this.redeComissaoAReceber();
    },
    parceiroComissaoAReceber(p) {
      if (!p) return 0;
      if (!this.livroComissaoOn()) return Number(p.comissaoDevida || 0);
      const hit = (this.comissoes.partners || []).find((x) => x.partner_id === p.partnerId);
      return hit ? Number(hit.open_total || 0) : 0;
    },
    parceiroAReceberTotal(p) {
      return p ? Number(p.mensalidadeDevida || 0) + this.parceiroComissaoAReceber(p) : 0;
    },

    redeConversao2w() {
      const total = this.redeTotalVendasValor();
      return total > 0 ? Math.round((this.redeTotal2w() / total) * 100) : 0;
    },

    redeEstoqueQuantidade() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + (parceiro.estoqueItens || []).reduce((itemSum, item) => itemSum + Number(item.qtd || 0), 0), 0);
    },

    redeEstoqueValor() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + (parceiro.estoqueItens || []).reduce((itemSum, item) => {
        return itemSum + (Number(item.qtd || 0) * Number(item.custoValor || 0));
      }, 0), 0);
    },

    rankingLucro() {
      return this.parceirosRede
        .filter((parceiro) => !parceiro.custoPendente && parceiro.lucroEstimado !== null)
        .sort((a, b) => Number(b.lucroEstimado) - Number(a.lucroEstimado))
        .slice(0, 4);
    },

    unidadesComCustoPendente() {
      return [...this.parceirosRede]
        .filter((parceiro) => parceiro.custoPendente)
        .sort((a, b) => Number(b.custoPendenteReceita || 0) - Number(a.custoPendenteReceita || 0));
    },

    rankingSaude() {
      return [...this.parceirosRede].sort((a, b) => this.saudeScore(b) - this.saudeScore(a)).slice(0, 5);
    },

    rankingDependencia2w() {
      return [...this.parceirosRede]
        .filter((parceiro) => Number(parceiro.vendasValor || 0) > 0)
        .sort((a, b) => Number(b.percentual2w || 0) - Number(a.percentual2w || 0))
        .slice(0, 5);
    },

    rankingTicket() {
      return [...this.parceirosRede]
        .filter((parceiro) => Number(parceiro.pedidos || 0) > 0)
        .sort((a, b) => Number(b.ticketValor || 0) - Number(a.ticketValor || 0))
        .slice(0, 5);
    },

    parceiroVendaHojeValor(parceiro) {
      const values = Array.isArray(parceiro?.serieVendas) ? parceiro.serieVendas : [];
      return Number(values.length > 0 ? values[values.length - 1] : 0);
    },

    unidadesSemVendaHoje() {
      return this.parceirosRede.filter((parceiro) => this.parceiroVendaHojeValor(parceiro) <= 0);
    },

    unidadesSemAtualizacao() {
      return this.parceirosRede.filter((parceiro) => parceiro.diasSemAtualizar === null || Number(parceiro.diasSemAtualizar) >= 4);
    },

    redeAlertasOperacionais() {
      const alerts = [];
      for (const parceiro of this.parceirosRede) {
        if (parceiro.custoPendente) {
          alerts.push({ tipo: 'Custo pendente', texto: `${parceiro.nome}: ${parceiro.custoPendenteItens} item(ns) sem custo histórico`, tom: 'text-amber-700 bg-amber-50' });
        }
        if (Number(parceiro.estoqueBaixo || 0) > 0) {
          alerts.push({ tipo: 'Estoque crítico', texto: `${parceiro.nome}: ${parceiro.estoqueBaixo} item(ns) baixo/zerado`, tom: 'text-amber-700 bg-amber-50' });
        }
        if (this.parceiroVendaHojeValor(parceiro) <= 0) {
          alerts.push({ tipo: 'Sem venda hoje', texto: `${parceiro.nome} ainda não registrou venda hoje`, tom: 'text-rose-700 bg-rose-50' });
        }
        if (parceiro.diasSemAtualizar === null || Number(parceiro.diasSemAtualizar) >= 4) {
          alerts.push({ tipo: 'Sem atualização', texto: `${parceiro.nome}: ${parceiro.ultimaAtualizacao || 'sem registro recente'}`, tom: 'text-blue-700 bg-blue-50' });
        }
        if (!parceiro.custoPendente && Number(parceiro.lucroEstimado) < 0) {
          alerts.push({ tipo: 'Resultado negativo', texto: `${parceiro.nome}: ${this.formatCurrency(parceiro.lucroEstimado)} no mês`, tom: 'text-rose-700 bg-rose-50' });
        }
        if (Number(parceiro.percentual2w || 0) >= 70) {
          alerts.push({ tipo: 'Alta dependência 2W', texto: `${parceiro.nome}: ${parceiro.percentual2w}% das vendas vêm da 2W`, tom: 'text-purple-700 bg-purple-50' });
        }
      }
      return alerts.slice(0, 8);
    },

    filteredParceirosRede() {
      let rows = this.parceirosRede;
      if (this.redeFilter === 'alerta') rows = rows.filter((parceiro) => parceiro.alerta !== 'ok');
      if (this.redeFilter === 'sem_venda') rows = this.unidadesSemVendaHoje();
      if (this.redeFilter === 'sem_atualizacao') rows = this.unidadesSemAtualizacao();
      if (this.redeFilter === 'dependencia_2w') rows = rows.filter((parceiro) => Number(parceiro.percentual2w || 0) >= 50);
      if (this.redeFilter === 'risco') rows = rows.filter((parceiro) => this.saudeScore(parceiro) < 60);
      const term = String(this.redeBusca || '').trim().toLocaleLowerCase('pt-BR');
      if (!term) return rows;
      return rows.filter((parceiro) => [
        parceiro.nome, parceiro.responsavel, parceiro.cidade, parceiro.status,
      ].some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(term)));
    },

  };
};
