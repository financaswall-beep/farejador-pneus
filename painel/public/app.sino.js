// SINO do painel da MATRIZ (2026-07-06): o sino do topo, vivo de verdade.
// O sino existia desde o desenho com notificacoes:[] morto — nunca tocava. Agora
// `notificacoes` é um GETTER que DERIVA dos dados reais (this.sino, do servidor,
// + comissão estourada que já vive no front): nada de estado duplicado — resolveu
// na aba, some do sino sozinho no próximo load. "Lida" é assinatura no
// localStorage (o item continua na lista, só perde a bolinha).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (mataria o getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.sino = function () {
  return {
    async loadSino() {
      this.ensureCredentials();
      if (!this.apiToken || !location.pathname.startsWith('/admin/painel')) return;
      try {
        this.sino = await this.apiGet('/admin/api/matriz/notificacoes');
      } catch (err) {
        this.sino = null; // sem resposta = sino vazio (não inventa alerta)
      }
    },

    // A lista que o dropdown renderiza. Cada item tem um id-assinatura: se o
    // ESTADO muda (mais uma medida baixa, total do fiado cresceu), o id muda e
    // a notificação volta a contar como não lida — mudou = re-avisar.
    get notificacoes() {
      const itens = [];
      const s = this.sino;
      if (s) {
        for (const e of s.entregas_falhadas || []) {
          itens.push({
            id: 'falha:' + e.order_id,
            icon: 'truck', iconBg: 'bg-rose-50', iconColor: 'text-rose-600',
            title: 'Entrega não realizada — você decide',
            desc: (e.customer_name || 'Cliente') + (e.reason ? ' — "' + e.reason + '"' : '') +
              '. Recoloque na fila ou cancele.',
            page: 'logistica', time: 'abrir Logística →',
          });
        }
        const repor = s.galpao_repor || [];
        if (repor.length > 0) {
          const nomes = repor.slice(0, 3).map((m) => m.measure + ' (' + m.quantity_on_hand + '/mín. ' + m.min_quantity + ')');
          itens.push({
            id: 'galpao:' + repor.map((m) => m.measure + m.quantity_on_hand).join(','),
            icon: 'package', iconBg: 'bg-amber-50', iconColor: 'text-amber-600',
            title: 'Galpão pra repor (' + repor.length + (repor.length === 1 ? ' medida)' : ' medidas)'),
            desc: nomes.join(' · ') + (repor.length > 3 ? ' e mais ' + (repor.length - 3) : ''),
            page: 'estoque', time: 'abrir Estoque →',
          });
        }
        if (s.fiado_vencido && s.fiado_vencido.count > 0) {
          itens.push({
            id: 'fiado:' + s.fiado_vencido.count + ':' + s.fiado_vencido.total,
            icon: 'wallet', iconBg: 'bg-rose-50', iconColor: 'text-rose-600',
            title: 'Fiado vencido no atacado',
            desc: s.fiado_vencido.count + ' venda(s) vencida(s), ' +
              this.formatCurrency(Number(s.fiado_vencido.total)) + ' pra cobrar.',
            page: 'financeiro', time: 'abrir Financeiro →',
          });
        }
        if (s.a_pagar_vencido && s.a_pagar_vencido.count > 0) {
          itens.push({
            id: 'pagar:' + s.a_pagar_vencido.count + ':' + s.a_pagar_vencido.total,
            icon: 'receipt', iconBg: 'bg-amber-50', iconColor: 'text-amber-600',
            title: 'Conta vencida a pagar',
            desc: s.a_pagar_vencido.count + ' conta(s) vencida(s), ' +
              this.formatCurrency(Number(s.a_pagar_vencido.total)) + ' no total.',
            page: 'financeiro', time: 'abrir Financeiro →',
          });
        }
      }
      // Comissão >= alarme do dono (alarme mora no localStorage — front soma sozinho).
      const estouradas = ((this.comissoes && this.comissoes.enabled && this.comissoes.partners) || [])
        .filter((p) => this.comissaoEstourou(p));
      if (estouradas.length > 0) {
        const total = estouradas.reduce((acc, p) => acc + Number(p.open_total || 0), 0);
        itens.push({
          id: 'comissao:' + total.toFixed(2),
          icon: 'coins', iconBg: 'bg-brand-50', iconColor: 'text-brand-600',
          title: 'Comissão passou do seu alarme',
          desc: estouradas.map((p) => p.partner_name).join(', ') + ' — ' +
            this.formatCurrency(total) + ' em aberto.',
          page: 'rede', time: 'abrir Rede →',
        });
      }
      return itens.map((n) => ({ ...n, read: this.sinoLidas.includes(n.id) }));
    },

    sinoClick(notif) {
      this.sinoMarcarLida(notif.id);
      this.currentPage = notif.page;
      this.$nextTick(() => lucide.createIcons());
    },

    sinoMarcarLida(id) {
      if (this.sinoLidas.includes(id)) return;
      // cap: assinaturas antigas saem pela frente (itens resolvidos somem da fonte)
      this.sinoLidas = [...this.sinoLidas, id].slice(-100);
      localStorage.setItem('farejador_sino_lidas', JSON.stringify(this.sinoLidas));
    },

    sinoMarcarTodas() {
      for (const n of this.notificacoes) this.sinoMarcarLida(n.id);
    },

  };
};
