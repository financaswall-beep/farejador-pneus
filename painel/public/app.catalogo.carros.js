window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.catalogoCarros = function () {
  function modelEndYear(form) {
    return form.year_end === '' || form.year_end == null ? form.year_start : form.year_end;
  }

  function validPeriod(form, endYear = form.year_end) {
    const start = Number(form.year_start);
    const end = Number(endYear);
    return Number.isInteger(start) && Number.isInteger(end)
      && start >= 1900 && end <= 2100 && start <= end;
  }

  function canWrite(context) {
    const state = context.catalogoCompatibilidade;
    return context.adminUser?.role === 'owner' && state.row?.vehicle_type === 'car'
      && Boolean(state.row.product_id) && !state.loading && !state.error && !state.saving;
  }

  const errors = {
    invalid_car_model: 'Confira a marca, o modelo e os anos do carro.',
    invalid_car_reference: 'Confira a medida, os anos, a posição e o link, se informado.',
    catalog_vehicle_model_conflict: 'Já existe um modelo com dados conflitantes. Confira a versão e o período.',
    catalog_vehicle_model_not_found: 'O modelo mudou. Pesquise o carro novamente.',
    catalog_product_not_found: 'O produto mudou. Reabra a ficha no catálogo.',
    catalog_car_required: 'Confira a categoria do pneu e do modelo na ficha.',
    catalog_application_measure_mismatch: 'A medida de referência precisa corresponder à medida deste pneu.',
    catalog_application_years_mismatch: 'Informe os anos da referência dentro do período do modelo.',
    catalog_application_conflict: 'Já existe uma referência conflitante para esse modelo, período e posição.',
  };

  return {
    catalogoCarStartModel() {
      const state = this.catalogoCompatibilidade;
      if (!canWrite(this)) return;
      this.catalogoCompatibilityResetSearch();
      state.search = '';
      state.carModel = { make: '', model: '', variant: '', year_start: '', year_end: '' };
      this.$nextTick(() => this.$refs.carMake?.focus());
    },

    catalogoCarCanCreate() {
      const form = this.catalogoCompatibilidade.carModel;
      return Boolean(form && canWrite(this) && form.make.trim() && form.model.trim() && validPeriod(form, modelEndYear(form)));
    },

    async catalogoCarCreate() {
      if (!this.catalogoCarCanCreate()) return;
      const state = this.catalogoCompatibilidade;
      const form = state.carModel;
      state.saving = true;
      state.message = null;
      try {
        const result = await this.apiPost('/admin/api/catalog/vehicle-models', {
          vehicle_type: 'car', make: form.make.trim(), model: form.model.trim(), variant: form.variant.trim() || null,
          year_start: Number(form.year_start), year_end: Number(modelEndYear(form)),
        });
        if (state !== this.catalogoCompatibilidade) return;
        this.catalogoCompatibilitySelectVehicle(result.vehicle);
        state.message = { ok: true, text: result.created ? 'Modelo de carro cadastrado.' : 'Modelo já cadastrado e selecionado.' };
      } catch (error) {
        state.message = { ok: false, text: errors[error.message] || 'Não foi possível cadastrar o modelo de carro.' };
      } finally {
        state.saving = false;
      }
    },

    catalogoCarStartReference() {
      const state = this.catalogoCompatibilidade;
      state.carAction = 'reference';
      state.carReference = {
        tire_size: state.row.tire_size ?? '', index_spec: '', source_url: '', position: '',
        year_start: state.selectedVehicle.year_start ?? '', year_end: state.selectedVehicle.year_end ?? '',
      };
    },

    catalogoCarCanSaveReference() {
      const state = this.catalogoCompatibilidade;
      const form = state.carReference;
      if (!form || !canWrite(this) || !state.selectedVehicle?.vehicle_model_id || state.carAction !== 'reference'
        || !form.tire_size.trim() || !validPeriod(form) || !['front', 'rear', 'both'].includes(form.position)) return false;
      if ((state.selectedVehicle.year_start && Number(form.year_start) < state.selectedVehicle.year_start)
        || (state.selectedVehicle.year_end && Number(form.year_end) > state.selectedVehicle.year_end)) return false;
      const sourceUrl = form.source_url.trim();
      if (!sourceUrl) return true;
      try {
        const url = new URL(sourceUrl);
        return url.protocol === 'https:' && !url.username && !url.password;
      } catch {
        return false;
      }
    },

    async catalogoCarSaveReference() {
      if (!this.catalogoCarCanSaveReference()) return;
      const state = this.catalogoCompatibilidade;
      const productId = state.row.product_id;
      const form = state.carReference;
      state.saving = true;
      state.message = null;
      try {
        const result = await this.apiPost(`/admin/api/catalog/${encodeURIComponent(productId)}/measure-applications`, {
          vehicle_model_id: state.selectedVehicle.vehicle_model_id, tire_size: form.tire_size.trim(),
          year_start: Number(form.year_start), year_end: Number(form.year_end), position: form.position,
          source_url: form.source_url.trim() || null, index_spec: form.index_spec.trim() || null,
        });
        if (state === this.catalogoCompatibilidade) {
          this.catalogoCompatibilityResetSearch();
          state.search = '';
          state.message = { ok: true, text: result.created ? 'Referência da medida registrada.' : 'Esta referência já está cadastrada.' };
          await this.catalogoCompatibilityLoad(productId);
        }
        await this.loadCatalogo();
      } catch (error) {
        state.message = { ok: false, text: errors[error.message] || 'Não foi possível registrar a referência da medida.' };
      } finally {
        state.saving = false;
      }
    },
  };
};
