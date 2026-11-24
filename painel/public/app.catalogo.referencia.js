window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.catalogoReferencia = function () {
  const path = productId => '/admin/api/catalog/' + encodeURIComponent(productId) + '/market-reference';
  const newForm = (row, record) => ({
    model: record?.model || row?.tread_pattern || '',
    amount: record ? Number(record.amount).toFixed(2) : '',
    sources: record?.sources.join('\n') || '',
    observed_on: record?.observed_on || '',
    valid_until: record?.valid_until || '',
    bot_enabled: record?.bot_enabled === true,
  });
  const errors = {
    market_reference_invalid: 'Confira o valor, as datas e os links. Use até 12 fontes diferentes.',
    market_reference_dates_invalid: 'Confira a data da consulta e a validade para o atendimento.',
    market_reference_model_mismatch: 'Confirme que a ficha é de carro e que o modelo cotado coincide com o modelo cadastrado.',
    catalog_product_not_found: 'O produto não está disponível no catálogo da Matriz.',
  };
  return {
    catalogoMarket: { loading: false, saving: false, loaded: false, message: '', error: '', form: newForm(), request: 0 },
    catalogoMarketSources() { return this.catalogoMarket.form.sources.split(/\r?\n/).map(line => line.trim()).filter(Boolean); },
    catalogoMarketCar() { return this.catalogoSelecionado?.vehicle_type === 'car'; },
    catalogoMarketMatches() {
      const model = value => (value || '').trim().toLocaleLowerCase('pt-BR');
      const current = model(this.catalogoSelecionado?.tread_pattern);
      return Boolean(current && current === model(this.catalogoMarket.form.model));
    },
    async catalogoMarketLoad(row) {
      const state = this.catalogoMarket;
      const request = ++state.request;
      Object.assign(state, { form: newForm(row), loading: false, loaded: false, error: '', message: '' });
      if (row?.product_type !== 'tire' || !row.product_id) return;
      state.loading = true;
      try {
        const { reference } = await this.apiGet(path(row.product_id));
        if (request !== state.request) return;
        state.form = newForm(row, reference);
        state.loaded = true;
      } catch (_) {
        if (request === state.request) state.error = 'Não foi possível consultar a referência online.';
      } finally { if (request === state.request) state.loading = false; }
    },
    async catalogoMarketSave() {
      const state = this.catalogoMarket;
      const row = this.catalogoSelecionado;
      if (state.saving || !state.loaded || row?.product_type !== 'tire' || !row.product_id) return;
      if (state.form.bot_enabled && (!this.catalogoMarketCar() || !this.catalogoMarketMatches())) {
        state.error = errors.market_reference_model_mismatch;
        state.message = '';
        return;
      }
      Object.assign(state, { saving: true, error: '', message: '' });
      const body = { ...state.form, amount: Number(state.form.amount),
        sources: this.catalogoMarketSources(), valid_until: state.form.valid_until || null };
      try {
        const { reference } = await this.apiPut(path(row.product_id), body);
        state.form = newForm(row, reference);
        state.message = 'Referência online salva.';
      } catch (error) { state.error = errors[error.message] || 'Não foi possível salvar a referência online.'; }
      finally { state.saving = false; }
    },
  };
};
