// Obra 300 (2026-07-05): fatia do painel da MATRIZ — logística ações: remarcar/pendurar/abrir/fechar rota/comprovante IA.
// VERBATIM das linhas 1406-1530 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.logisticaAcoes = function () {
  return {
    async remarcarEntrega(d, novaData) {
      if (!novaData || novaData === d.scheduled_date) return;
      this.logisticaSaving = true;
      try {
        await this.apiPost('/admin/api/logistica/entregas/remarcar', { order_id: d.order_id, scheduled_date: novaData });
        this.logisticaMsg = { ok: true, text: 'Entrega remarcada.' };
        await this.loadLogistica();
      } catch (err) {
        this.logisticaMsg = { ok: false, text: `Não consegui remarcar (${err.message}).` };
      } finally {
        this.logisticaSaving = false;
      }
    },
    // Pendura uma entrega em aberto na rota que já está na rua (o "pendurar depois").
    async pendurarNaRota(d) {
      const rota = this.rotaAberta();
      if (!rota) { this.logisticaMsg = { ok: false, text: 'Nenhuma rota aberta. Abra uma rota primeiro.' }; return; }
      this.logisticaSaving = true;
      try {
        await this.apiPost('/admin/api/logistica/rotas/pendurar', { order_id: d.order_id, trip_id: rota.id });
        this.logisticaMsg = { ok: true, text: `Entrega posta na rota de ${rota.courier_name || 'entregador'}.` };
        await this.loadLogistica();
      } catch (err) {
        this.logisticaMsg = { ok: false, text: `Não consegui pôr na rota (${err.message}).` };
      } finally {
        this.logisticaSaving = false;
      }
    },
    async abrirRota() {
      const courier = (this.rotaForm.courier_name || '').trim();
      if (!courier) { this.logisticaMsg = { ok: false, text: 'Diga o nome do entregador.' }; return; }
      const ids = Object.keys(this.rotaForm.selecionadas).filter((id) => this.rotaForm.selecionadas[id]);
      // Decisão do dono 07-03c: rota não abre vazia (o backend também barra).
      if (!ids.length) { this.logisticaMsg = { ok: false, text: 'Marque pelo menos 1 entrega pra abrir a rota. Sem entrega, não abre.' }; return; }
      this.logisticaSaving = true;
      try {
        const r = await this.apiPost('/admin/api/logistica/rotas', {
          courier_name: courier,
          km_start: this.rotaForm.km_start === '' ? null : Number(this.rotaForm.km_start),
          order_ids: ids,
        });
        this.logisticaMsg = { ok: true, text: `Rota aberta pra ${courier} com ${r.deliveries_count} entrega(s).` };
        this.rotaForm = { courier_name: '', km_start: '', selecionadas: {} };
        await this.loadLogistica();
      } catch (err) {
        this.logisticaMsg = { ok: false, text: `Não consegui abrir a rota (${err.message}).` };
      } finally {
        this.logisticaSaving = false;
      }
    },
    async fecharRota(t) {
      const abertasNaRota = (this.logistica?.abertas || []).filter((d) => d.trip_id === t.id).length;
      if (abertasNaRota > 0 && !window.confirm(`Ainda tem ${abertasNaRota} entrega(s) em aberto nessa rota. Fechar mesmo assim?`)) return;
      this.logisticaSaving = true;
      try {
        await this.apiPost('/admin/api/logistica/rotas/fechar', {
          trip_id: t.id,
          km_end: this.fecharForm.km_end === '' ? null : Number(this.fecharForm.km_end),
          // Combustível nasce do comprovante anexado e lido; não existe valor fixo
          // nem digitação paralela no fechamento (evita divergência/duplicidade).
          fuel_spent: null,
          notes: (this.fecharForm.notes || '').trim() || null,
        });
        this.logisticaMsg = { ok: true, text: 'Rota fechada. Gasolina anotada só entra no resultado após comprovante aprovado.' };
        this.fecharForm = { km_end: '', notes: '' };
        await this.loadLogistica();
      } catch (err) {
        this.logisticaMsg = { ok: false, text: `Não consegui fechar a rota (${err.message}).` };
      } finally {
        this.logisticaSaving = false;
      }
    },
    async enviarComprovante(t, ev) {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        this.logisticaMsg = { ok: false, text: 'Manda uma FOTO do comprovante (JPG/PNG/WebP).' };
        ev.target.value = '';
        return;
      }
      this.uploadingReceipt = true;
      try {
        const resp = await fetch(`/admin/api/logistica/rotas/${t.id}/comprovante`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': file.type },
          body: file,
        });
        const payload = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          this.logisticaMsg = { ok: false, text: this.receiptUploadErrorMessage(payload) };
          return;
        }
        if (payload.duplicate) {
          this.logisticaMsg = { ok: true, text: 'Este comprovante já estava nesta rota; nenhum arquivo ou lançamento foi duplicado.' };
        } else if (payload.ai_status === 'parsed') {
          this.logisticaMsg = { ok: true, text: `Sugestão da IA pronta: ${payload.ai_summary}. Confira e aprove; nenhum valor entrou no Financeiro.` };
        } else if (payload.ai_status === 'unreadable') {
          this.logisticaMsg = { ok: true, text: `Comprovante guardado sem leitura confiável (${payload.ai_summary || 'ilegível'}). Preencha e aprove manualmente.` };
        } else if (payload.ai_status === 'pending') {
          this.logisticaMsg = { ok: false, text: 'Comprovante guardado; a leitura falhou agora. Ele continua aguardando revisão e pode ser relido.' };
        } else {
          this.logisticaMsg = { ok: true, text: 'Comprovante guardado. A IA está desligada; revise os campos manualmente.' };
        }
        await this.loadLogistica();
      } catch (err) {
        this.logisticaMsg = { ok: false, text: `Não consegui subir o comprovante (${err.message}).` };
      } finally {
        this.uploadingReceipt = false;
        ev.target.value = '';
      }
    },
    async lerComprovante(r) {
      this.logisticaSaving = true;
      try {
        const res = await this.apiPost('/admin/api/logistica/comprovantes/ler', { receipt_id: r.id });
        this.logisticaMsg = res.ai_status === 'parsed'
          ? { ok: true, text: `Nova sugestão pronta: ${res.ai_summary}. Nada foi lançado; revise e aprove.` }
          : { ok: false, text: `A IA não conseguiu concluir (${res.ai_summary || 'ilegível'}). O comprovante continua revisável.` };
        await this.loadLogistica();
      } catch (err) {
        this.logisticaMsg = { ok: false, text: 'A leitura falhou (IA fora do ar?) — tenta de novo daqui a pouco.' };
      } finally {
        this.logisticaSaving = false;
      }
    },
    // ── REPORTADAS pelo entregador (0125 → auditoria 07-08): o dono DECIDE ──
    // O portal marca failed SEM cancelar; aqui a decisão vira botão:
    // RECOLOCAR (volta pra fila, solta da rota, limpa o motivo) ou
    // CONFIRMAR (cancela o pedido e o galpão volta — caminho atômico fdd9148).
    async logisticaRecolocar(d) {
      this.logisticaSaving = true;
      try {
        await this.apiPost('/admin/api/logistica/entregas/recolocar', { order_id: d.order_id });
        this.logisticaMsg = { ok: true, text: 'Entrega recolocada na fila — sai na próxima rota.' };
        await this.loadLogistica();
        void this.loadSino(); // saiu do limbo → o aviso do sino some
      } catch (err) {
        this.logisticaMsg = { ok: false, text: `Não consegui recolocar (${err.message}).` };
      } finally {
        this.logisticaSaving = false;
      }
    },
    async logisticaConfirmarFalha(d) {
      const who = d.customer_name || 'este pedido';
      if (!window.confirm(`Confirmar o NÃO-ENTREGUE de ${who}?\n\nO pedido é cancelado e o pneu VOLTA pro galpão.`)) return;
      this.logisticaSaving = true;
      try {
        await this.apiPost('/admin/api/logistica/entregas/falhou', {
          order_id: d.order_id,
          reason: d.delivery_failure_reason || 'não entregue — confirmado pelo dono',
        });
        this.logisticaMsg = { ok: true, text: 'Não-entregue confirmado — pedido cancelado e galpão recomposto.' };
        await this.loadLogistica();
        void this.loadSino();
      } catch (err) {
        this.logisticaMsg = { ok: false, text: `Não consegui confirmar (${err.message}).` };
      } finally {
        this.logisticaSaving = false;
      }
    },

    // ── COLABORADORES da matriz (0124 — fatia 1: cadastro; a pessoa ainda não loga) ──
  };
};
