// Audited decisions about identities and conversion delivery; no publication actions.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingReviews = function () {
  return {
    metaIdentityReviews: {rows:[],pending:0}, googleConversionReviews: [],
    marketingReviewSeq: 0, marketingReviewLoading: false, marketingReviewError: '',
    marketingReviewSelection: null, marketingReviewScope: 'matrix', marketingReviewAction: 'check',
    marketingReviewReason: '', marketingReviewBusy: false,
    async loadMarketingReviews() {
      if (this.marketingIsMock()) return;
      const seq=++this.marketingReviewSeq;
      this.marketingReviewLoading=true;this.marketingReviewError='';
      const results=await Promise.allSettled([
        this.apiGet('/admin/api/marketing/meta/identity-reviews'),
        this.apiGet('/admin/api/marketing/google-ads/conversion-reviews'),
      ]);
      if(seq!==this.marketingReviewSeq)return;
      this.metaIdentityReviews=results[0].status==='fulfilled'?results[0].value:{rows:[],pending:0};
      this.googleConversionReviews=results[1].status==='fulfilled'?results[1].value.rows||[]:[];
      if(results.some(result=>result.status==='rejected'))this.marketingReviewError='Uma das listas de revisão não pôde ser carregada. Atualize antes de decidir.';
      this.marketingReviewLoading=false;
    },
    marketingReviewChoose(kind,row) {
      this.marketingReviewSelection={kind,row};this.marketingReviewReason='';
      this.marketingReviewScope='matrix';this.marketingReviewAction=row.can_check?'check':'close';
    },
    marketingReviewReasonLabel(code) {
      return {google_ingest_ambiguous:'O envio foi interrompido e precisa ser conferido.',
        data_manager_partial_result:'O Google retornou um resultado parcial.',
        data_manager_processing_failed:'O Google confirmou falha no processamento.',
        data_manager_rejected:'O Google recusou o envio.',
        data_manager_quota:'O Google recusou o envio por limite de uso.',
        data_manager_auth_failed:'O Google recusou a autenticação.',
        invalid_conversion:'Os dados da conversão precisam ser revisados.',
        sent_sale_cancelled:'A venda foi cancelada depois do envio.',
        accepted_sale_cancelled:'A venda foi cancelada enquanto o envio era processado.',
        google_processing_timeout:'O processamento ainda não foi confirmado.'}[code]
        ||'A confirmação do envio precisa de revisão.';
    },
    async marketingReviewFromGoogle(row) {
      this.marketingSetTab('integracoes');
      await this.loadMarketingReviews();
      const current=this.googleConversionReviews.find(item=>item.id===row.id);
      if(current)this.marketingReviewChoose('google',current);
    },
    async marketingReviewSubmit() {
      const selected=this.marketingReviewSelection,reason=this.marketingReviewReason.trim();
      if(!selected||reason.length<10||this.marketingReviewBusy||this.marketingIsMock())return;
      this.marketingReviewBusy=true;this.marketingReviewError='';
      try {
        const row=selected.row;
        const url=selected.kind==='meta'
          ? `/admin/api/marketing/meta/ad-accounts/${encodeURIComponent(row.ad_account_id)}/ads/${encodeURIComponent(row.ad_id)}/identity-decision`
          : `/admin/api/marketing/google-ads/conversions/${encodeURIComponent(row.id)}/review`;
        const result=await this.apiPost(url,selected.kind==='meta'?{scope:this.marketingReviewScope,reason}:{action:this.marketingReviewAction,reason});
        this.marketingIntegrationsMessage=selected.kind==='meta'
          ? 'Decisão registrada. Execute a coleta Meta para atualizar as métricas; os outros anúncios mantêm sua classificação.'
          : result.queued?'Venda recolocada na fila após comprovação da falha.'
            : result.status==='closed'?'Revisão encerrada sem novo envio. O histórico foi preservado.'
              : `Conferência concluída: ${this.googleConversionStatus(result.status)}.`;
        this.marketingReviewSelection=null;await this.loadMarketingReviews();
      } catch(error) {
        const code=error?.code||error?.error||error?.message;
        this.marketingReviewError={google_retry_not_proven_safe:'Não há comprovação de rejeição. O reenvio foi bloqueado para evitar duplicidade.',
          google_sale_not_eligible:'A venda não está mais elegível. Confira o pedido e o consentimento.',
          google_request_missing:'Esse envio não tem protocolo para consulta. Confira no Google e encerre a revisão sem reenviar.',
          meta_identity_sync_required:'Execute a coleta Meta antes de confirmar essa identidade.'}[code]
          ||'Não foi possível concluir a decisão. Atualize as listas antes de tentar novamente.';
      } finally {this.marketingReviewBusy=false;}
    },
  };
};
