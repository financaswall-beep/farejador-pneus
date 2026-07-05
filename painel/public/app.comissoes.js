// Obra 300 (2026-07-05): fatia do painel da MATRIZ — comissões da Rede (0118): carregar/quitar/alarme/termos.
// VERBATIM das linhas 844-914 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.comissoes = function () {
  return {
    async loadComissoes() {
      this.ensureCredentials();
      if (!this.apiToken || !location.pathname.startsWith('/admin/painel')) return;
      try {
        this.comissoes = (await this.apiGet('/admin/api/rede/comissoes')) || null;
      } catch (err) {
        this.comissoes = null; // sem resposta = bloco some (não inventa número)
      }
    },
    async settleComissao(p) {
      const total = this.formatCurrency(Number(p.open_total || 0));
      if (!confirm(`Confirmar RECEBIDO de ${p.partner_name}?\n\n${p.open_count} lançamento(s) em aberto, total ${total}, viram "recebido" agora.`)) return;
      this.comissaoSettling = p.partner_id;
      try {
        await this.apiPost('/admin/api/rede/comissoes/settle', { partner_id: p.partner_id });
        await this.loadComissoes();
      } catch (err) {
        alert('Não deu pra quitar: ' + (err instanceof Error ? err.message : err));
      } finally {
        this.comissaoSettling = null;
      }
    },
    setComissaoAlerta(value) {
      this.comissaoAlerta = Math.max(0, Number(value) || 0);
      localStorage.setItem('farejador_comissao_alerta', String(this.comissaoAlerta));
    },
    comissaoEstourou(p) {
      return this.comissaoAlerta > 0 && Number(p.open_total || 0) >= this.comissaoAlerta;
    },
    // Atalho "cobrar no WhatsApp" (deep-link wa.me — padrão da casa, fora da API Meta).
    comissaoWhatsLink(p) {
      const digits = String(p.whatsapp_phone || '').replace(/\D/g, '');
      if (!digits) return null;
      const tel = digits.startsWith('55') ? digits : '55' + digits;
      const msg = 'Fala! Fechou ' + this.formatCurrency(Number(p.open_total || 0)) +
        ' de comissão das vendas que o Farejador mandou pra você. Como prefere acertar?';
      return 'https://wa.me/' + tel + '?text=' + encodeURIComponent(msg);
    },
    // Editor do modelo comercial (página da unidade): pré-carrega da ficha do parceiro
    // selecionado. Vale pra comissões NOVAS — lançamento antigo fica com o % da época.
    abrirTermsForm() {
      const p = this.selectedParceiro();
      if (!p) return;
      this.termsForm = {
        model: p.modeloComercialRaw || 'commission',
        percent: p.comissaoPercentRaw === null || p.comissaoPercentRaw === undefined ? '' : p.comissaoPercentRaw,
        fee: p.mensalidadeRaw === null || p.mensalidadeRaw === undefined ? '' : p.mensalidadeRaw,
      };
    },
    async salvarTerms() {
      const p = this.selectedParceiro();
      if (!p || !p.partnerId) return;
      this.termsSaving = true;
      this.termsMsg = null;
      try {
        await this.apiPost(`/admin/api/partners/${p.partnerId}/terms`, {
          commercial_model: this.termsForm.model,
          commission_percent: this.termsForm.percent === '' ? null : Number(this.termsForm.percent),
          monthly_fee: this.termsForm.fee === '' ? null : Number(this.termsForm.fee),
        });
        this.termsMsg = 'Salvo ✓';
        await this.loadRealData(); // a ficha muda o rótulo da Rede (comissão %)
      } catch (err) {
        this.termsMsg = 'Erro: ' + (err instanceof Error ? err.message : err);
      } finally {
        this.termsSaving = false;
        setTimeout(() => { this.termsMsg = null; }, 4000);
      }
    },

    // ── ATACADO (Fase 1) — venda pro borracheiro + ranking de recompra ──
  };
};
