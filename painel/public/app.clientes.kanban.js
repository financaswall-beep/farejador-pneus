window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.clientesKanban = function () {
  return {
    clientesMostrarArquivados: false,
    clientesLeadLimites: { novo: 12, atendimento: 12, orcamento: 12, perdido: 12, convertido: 12 },
    clienteLeadArrastandoId: null,
    clienteLeadSalvandoId: null,

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
      this.clientesMostrarArquivados = !this.clientesMostrarArquivados;
      if (this.clientesMostrarArquivados) this.clientesPeriodo = 'todos';
      this.clienteSelecionadoId = null;
      this.$nextTick(() => lucide.createIcons());
    },

    clienteLeadPodeMover(c) {
      return c && !c.lead_archived && this.clienteLeadLane(c) !== 'convertido';
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

    async arquivarClienteLead(lead) {
      if (!lead || lead.lead_archived) return;
      if (!confirm(`Arquivar o card de ${lead.name}?\n\nA conversa, o cliente e as vendas serão mantidos.`)) return;
      await this.salvarClienteLead(lead, 'archive');
    },

    async restaurarClienteLead(lead) {
      if (!lead?.lead_archived) return;
      await this.salvarClienteLead(lead, 'restore');
    },

    async salvarClienteLead(lead, action, lane) {
      if (!lead?.lead_conversation_id || this.clienteLeadSalvandoId) return;
      this.clienteLeadSalvandoId = lead.id;
      try {
        const response = await fetch(`/admin/api/clientes/leads/${encodeURIComponent(lead.lead_conversation_id)}`, {
          method: 'PATCH', credentials: 'same-origin', headers: this.apiHeaders(),
          body: JSON.stringify({
            action, ...(lane ? { lane } : {}),
            expected_version: Number(lead.lead_board_version || 0),
            idempotency_key: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
          }),
        });
        if (response.status === 401) this.adminUnauthorized();
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `api_${response.status}`);
        lead.lead_board_version = payload.version;
        lead.lead_archived = payload.archived;
        if (action === 'move') lead.lead_lane = payload.manual_lane || lead.lead_derived_lane;
        if (action === 'archive') this.clienteSelecionadoId = null;
        await this.loadClientes(true);
      } catch (error) {
        const code = String(error?.message || error);
        if (code === 'lead_version_conflict') {
          await this.loadClientes(true);
          alert('Esse card mudou em outra tela. Atualizei o quadro; tente novamente.');
        } else {
          alert('Não foi possível atualizar o card. Nada foi apagado.');
        }
      } finally {
        this.clienteLeadSalvandoId = null;
      }
    },
  };
};
