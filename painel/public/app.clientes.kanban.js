window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.clientesKanban = function () {
  return {
    clientesMostrarArquivados: false,
    clientesLeadLimites: { novo: 12, atendimento: 12, orcamento: 12, perdido: 12, convertido: 12 },
    clienteLeadArrastandoId: null,
    clienteLeadSalvandoId: null,
    clientesLeadLimpezaAberta: false,
    clientesLeadSelecionando: false,
    clientesLeadMarcados: [],
    clientesLeadLote: null,
    clientesLeadAviso: '',
    clientesLeadErro: '',

    clientesLeadsVisiveis(lane) {
      return this.clientesLeads(lane).slice(0, Number(this.clientesLeadLimites[lane] || 12));
    },

    clientesLeadMostrarMais(lane) {
      this.clientesLeadLimites[lane] = Number(this.clientesLeadLimites[lane] || 12) + 12;
      this.$nextTick(() => lucide.createIcons());
    },

    clientesLeadArquivadosTotal() {
      return this.clientes
        .filter((c) => c.source === 'chatwoot' && c.lead_conversation_id && c.lead_archived).length;
    },

    clienteLeadAlternarArquivados() {
      if (this.clientesLeadLote) return;
      this.clientesMostrarArquivados = !this.clientesMostrarArquivados;
      if (this.clientesMostrarArquivados) this.clientesPeriodo = 'todos';
      this.clienteSelecionadoId = null;
      this.clientesLeadMarcados = [];
      this.clientesLeadSelecionando = false;
      this.clientesLeadLimpezaAberta = false;
      this.clienteLeadDetalheAberto = false;
      this.$nextTick(() => lucide.createIcons());
    },

    clienteLeadPodeMover(c) {
      return c && !this.clientesLeadLote && !this.clienteLeadSalvandoId && !this.clientesLeadSelecionando
        && !c.lead_archived && this.clienteLeadLane(c) !== 'convertido';
    },

    clienteLeadDragStart(c, event) {
      if (!this.clienteLeadPodeMover(c)) {
        event?.preventDefault();
        return;
      }
      this.clienteLeadArrastandoId = c.id;
      if (event?.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', c.id);
      }
    },

    clienteLeadDragEnd() {
      this.clienteLeadArrastandoId = null;
    },

    async clienteLeadDrop(lane) {
      const id = this.clienteLeadArrastandoId;
      this.clienteLeadArrastandoId = null;
      const lead = this.clientes.find((row) => row.id === id);
      if (!lead || !this.clienteLeadPodeMover(lead)) return;
      if (lane === 'convertido') {
        alert('Convertido é automático: o card entra aqui somente depois de uma venda confirmada.');
        return;
      }
      if (this.clienteLeadLane(lead) === lane) return;
      await this.salvarClienteLead(lead, 'move', lane);
    },

    async alterarClienteLeadLane(lead, lane) {
      if (!lead || !lane || lane === 'convertido' || !this.clienteLeadPodeMover(lead)) return;
      if (this.clienteLeadLane(lead) === lane) return;
      await this.salvarClienteLead(lead, 'move', lane);
    },

    async retomarClienteLeadAutomatico(lead) {
      if (!lead?.lead_manual_lane || !this.clienteLeadPodeMover(lead)) return;
      await this.salvarClienteLead(lead, 'automatic');
    },

    async assumirControleClienteLead(lead) {
      if (!this.clienteLeadPodeMover(lead)) return;
      await this.salvarClienteLead(lead, 'move', this.clienteLeadLane(lead));
    },

    async arquivarClienteLead(lead) {
      if (!lead || lead.lead_archived || this.clientesLeadLote) return;
      if (!confirm(`Arquivar o card de ${lead.name}?\n\nA conversa, o cliente e as vendas serão mantidos.`)) return;
      await this.salvarClienteLead(lead, 'archive');
    },

    async restaurarClienteLead(lead) {
      if (!lead?.lead_archived || this.clientesLeadLote) return;
      await this.salvarClienteLead(lead, 'restore');
    },

    async salvarClienteLead(lead, action, lane, lote = false) {
      if (!lead?.lead_conversation_id || this.clienteLeadSalvandoId || (this.clientesLeadLote && !lote)) return false;
      this.clienteLeadSalvandoId = lead.id;
      if (!lote) { this.clientesLeadAviso = ''; this.clientesLeadErro = ''; }
      try {
        const response = await fetch(`/admin/api/clientes/leads/${encodeURIComponent(lead.lead_conversation_id)}`, {
          method: 'PATCH', credentials: 'same-origin', headers: this.apiHeaders(),
          body: JSON.stringify({
            action, ...(lane ? { lane } : {}),
            expected_version: Number(lead.lead_board_version || 0),
            idempotency_key: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
          }),
        });
        if (response.status === 401) { this.adminUnauthorized(); throw new Error('unauthorized'); }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `api_${response.status}`);
        lead.lead_board_version = payload.version;
        lead.lead_archived = payload.archived;
        lead.lead_manual_lane = payload.manual_lane;
        if (['move', 'automatic'].includes(action) && lead.lead_derived_lane !== 'convertido') {
          lead.lead_lane = payload.manual_lane || lead.lead_derived_lane;
        }
        if (action === 'archive' && this.clienteSelecionadoId === lead.id) this.fecharClienteLeadDetalhe();
        if (!lote) {
          this.clientesLeadAviso = ({ move: 'Etapa definida pela equipe.', automatic: 'Movimentação automática retomada.',
            archive: 'Card arquivado. O histórico foi preservado.', restore: 'Card restaurado no quadro.' })[action];
          await this.loadClientes(true);
        }
        return true;
      } catch (error) {
        const code = String(error?.message || error);
        if (!lote) {
          this.clientesLeadErro = code === 'lead_version_conflict'
            ? 'Esse card mudou em outra tela. Atualizei o quadro; confira a etapa e tente novamente.'
            : 'Não foi possível confirmar a alteração. Atualize o quadro antes de tentar novamente.';
          if (this.adminAuthenticated) await this.loadClientes(true);
        }
        return false;
      } finally {
        this.clienteLeadSalvandoId = null;
      }
    },

    clientesLeadCardsDoQuadro() {
      return ['novo', 'atendimento', 'orcamento', 'perdido', 'convertido'].flatMap((lane) => this.clientesLeads(lane));
    },
    clientesLeadMarcar(id) {
      if (this.clientesLeadLote) return;
      this.clientesLeadMarcados = this.clientesLeadMarcados.includes(id)
        ? this.clientesLeadMarcados.filter((value) => value !== id) : [...this.clientesLeadMarcados, id];
    },
    clientesLeadIniciarSelecao() {
      this.clientesLeadSelecionando = true;
      this.clientesLeadMarcados = [];
      this.clientesLeadLimpezaAberta = false;
    },
    clientesLeadCancelarSelecao() {
      if (this.clientesLeadLote) return;
      this.clientesLeadSelecionando = false;
      this.clientesLeadMarcados = [];
    },
    clientesLeadQuantidadeMarcados() {
      return this.clientesLeadCardsDoQuadro().filter((c) => this.clientesLeadMarcados.includes(c.id)).length;
    },
    async arquivarClientesLeadLote(concluidos = false) {
      if (this.clientesLeadLote || this.clienteLeadSalvandoId || this.clientesMostrarArquivados) return;
      const targets = this.clientesLeadCardsDoQuadro().filter((c) => !c.lead_archived && (concluidos
        ? ['perdido', 'convertido'].includes(this.clienteLeadLane(c)) : this.clientesLeadMarcados.includes(c.id)))
        .map((c) => ({ ...c }));
      this.clientesLeadLimpezaAberta = false;
      if (!targets.length) { this.clientesLeadAviso = 'Nenhum card correspondente nos filtros atuais.'; return; }
      if (!confirm(`Arquivar ${targets.length} card(s) ${concluidos ? 'concluído(s)' : 'selecionado(s)'}?\n\nSomente os cards carregados nos filtros atuais. Conversas, clientes e vendas serão preservados. Você poderá restaurar os cards em Arquivados.`)) return;
      this.clientesLeadLote = { total: targets.length, feitos: 0 };
      this.clientesLeadAviso = ''; this.clientesLeadErro = '';
      const archived = [];
      try {
        for (const lead of targets) {
          if (!this.adminAuthenticated) break;
          if (await this.salvarClienteLead(lead, 'archive', undefined, true)) archived.push(lead.id);
          this.clientesLeadLote.feitos++;
        }
      } finally {
        this.clientesLeadLote = null;
        this.clientesLeadMarcados = targets.filter((c) => !archived.includes(c.id)).map((c) => c.id);
        this.clientesLeadSelecionando = this.clientesLeadMarcados.length > 0;
        if (this.adminAuthenticated) await this.loadClientes(true);
        this.clientesLeadAviso = `${archived.length} de ${targets.length} card(s) arquivado(s). Histórico preservado.`;
        if (archived.length !== targets.length) this.clientesLeadErro = 'Alguns cards mudaram ou não tiveram a operação confirmada. Confira os cards restantes antes de tentar novamente.';
      }
    },
  };
};
