window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.catalogPhotos = function () {
  return {
    catalogSection: 'products',
    matrixPhotos: { rows: [], loading: false, busy: false, error: '', notice: '', enabled: false,
      storageReady: false, botReady: false, drive: {}, selected: null, angle: 'front', search: '', filter: 'all', page: 1,
      preview: false, driveOpen: false, folder: '', driveEnabled: false, seq: 0, truncated: false },
    async mcphLoad() {
      if (this.adminUser?.role !== 'owner' || !this.isMatrixPanel()) return;
      const state = this.matrixPhotos, seq = ++state.seq, selectedId = state.selected?.product_id;
      state.loading = true; state.error = '';
      try {
        const data = await this.apiGet('/admin/api/catalog/photos');
        if (seq !== state.seq) return;
        state.rows = data.rows || []; state.enabled = data.enabled; state.storageReady = data.storage_ready;
        state.botReady = data.bot_ready === true;
        state.drive = data.drive || {}; state.truncated = data.truncated;
        state.page = Math.min(state.page, Math.max(1, Math.ceil(this.mcphFiltered().length / 12)));
        if (selectedId) this.mcphOpen(state.rows.find(row => row.product_id === selectedId) || null, true);
      } catch (error) { state.error = this.mcphError(error.message); }
      finally { if (seq === state.seq) state.loading = false; }
    },
    mcphOpen(row, preserve = false) {
      const state = this.matrixPhotos;
      state.selected = row; state.preview = false;
      if (!preserve) { state.notice = ''; state.error = ''; state.driveOpen = false; state.angle = 'front'; }
      state.folder = row?.drive_folder_id || ''; state.driveEnabled = row?.drive_enabled || false;
    },
    mcphStatus(row) {
      if (row.photos?.length && row.enabled) return 'Pronto para o bot';
      if (row.photos?.length) return 'Uso no bot pausado';
      if (row.drive_error) return 'Importação precisa de atenção';
      if (row.drive_enabled && !row.drive_checked_at) return 'Aguardando importação';
      return 'Sem foto';
    },
    mcphFiltered() {
      const state = this.matrixPhotos, search = state.search.trim().toLocaleLowerCase('pt-BR');
      return state.rows.filter(row => {
        const has = !!row.photos?.length;
        if (state.filter === 'missing' && has) return false;
        if (state.filter === 'ready' && !(has && row.enabled)) return false;
        if (state.filter === 'error' && !row.drive_error) return false;
        return !search || [row.tire_size, row.brand, row.product_name].join(' ').toLocaleLowerCase('pt-BR').includes(search);
      });
    },
    mcphPageRows() { return this.mcphFiltered().slice((this.matrixPhotos.page - 1) * 12, this.matrixPhotos.page * 12); },
    mcphPhoto(row = this.matrixPhotos.selected, angle = this.matrixPhotos.angle) { return row?.photos?.find(photo => photo.angle === angle); },
    mcphPrimary(row = this.matrixPhotos.selected) { return row?.photos?.find(photo => photo.is_primary) || row?.photos?.[0]; },
    mcphImage(photo) { return photo?.id ? '/admin/api/catalog/photos/' + encodeURIComponent(photo.id) + '/image' : ''; },
    mcphAngleLabel(angle) { return { front: 'Principal / frente', side: 'Lateral', detail: 'Detalhe / traseira' }[angle]; },
    async mcphRequest(url, options) {
      const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(60000), ...options });
      if (response.status === 401) this.adminUnauthorized();
      if (!response.ok) throw Error((await response.json().catch(() => ({}))).error || 'api_' + response.status);
      return response.json();
    },
    async mcphUpload(event) {
      const file = event.target.files?.[0], state = this.matrixPhotos, productId = state.selected?.product_id, angle = state.angle;
      event.target.value = '';
      if (!file || !productId || state.busy) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { state.error = 'Escolha uma foto JPG, PNG ou WebP.'; return; }
      if (file.size > 10 * 1024 * 1024) { state.error = 'A foto deve ter até 10 MB.'; return; }
      state.busy = true; state.error = ''; state.notice = 'Preparando foto e aplicando a marca 2W…';
      try {
        await this.mcphRequest('/admin/api/catalog/' + productId + '/photos?angle=' + angle, {
          method: 'POST', headers: { 'Content-Type': file.type, 'X-Upload-Id': crypto.randomUUID() }, body: file,
        });
        await this.mcphLoad(); state.notice = 'Foto cadastrada com a marca 2W.';
      } catch (error) { state.notice = ''; state.error = this.mcphError(error.message); }
      finally { state.busy = false; }
    },
    async mcphSave(patch) {
      const state = this.matrixPhotos, row = state.selected;
      if (!row || state.busy) return;
      state.busy = true; state.error = ''; state.notice = '';
      try {
        await this.mcphRequest('/admin/api/catalog/' + row.product_id + '/photo-settings', {
          method: 'PATCH', headers: this.apiHeaders(), body: JSON.stringify({ version: row.version || 1, ...patch }),
        });
        await this.mcphLoad(); state.notice = 'Preferências salvas.';
      } catch (error) { state.selected = { ...row }; state.error = this.mcphError(error.message); }
      finally { state.busy = false; }
    },
    mcphPreview() { this.matrixPhotos.preview = true; },
    mcphCaption() { return 'Segue uma foto de referência desse pneu.'; },
    mcphError(code) {
      return ({ settings_changed: 'O cadastro mudou em outra tela. Atualize antes de salvar.',
        photo_too_large: 'A foto deve ter até 10 MB.', not_an_image: 'Escolha uma imagem válida.',
        photo_processing_busy: 'Outra foto está sendo preparada. Aguarde alguns segundos e tente novamente.',
        invalid_or_small_photo: 'Não foi possível ler a foto. Use uma imagem com pelo menos 200 × 200 pixels.',
        photo_storage_unavailable: 'Não foi possível guardar a foto. Tente novamente.',
        storage_not_configured: 'O armazenamento de fotos precisa ser configurado no servidor.',
        catalog_bucket_policy_invalid: 'O armazenamento do catálogo precisa ser revisado no servidor.',
        product_not_found: 'Este produto não está disponível no Catálogo.',
        invalid_photo_settings: 'Confira o link da pasta e as preferências.',
        drive_folder_required: 'Informe a pasta do Drive antes de ligar a importação.',
        drive_folder_access_denied: 'Compartilhe a pasta do Drive com o e-mail de importação abaixo, como leitor.',
        drive_not_configured: 'A conexão com o Google Drive precisa ser configurada no servidor.',
        drive_authorization_failed: 'Não foi possível autenticar no Drive. Revise a conexão no servidor.',
        drive_duplicate_angle: 'Há duas fotos para o mesmo ângulo na pasta. Mantenha uma de cada.',
        drive_no_named_photos: 'Use principal.jpg, lateral.jpg ou detalhe.jpg na pasta vinculada.',
        drive_folder_too_large: 'Use uma pasta exclusiva do pneu, com até 100 imagens.',
        drive_photo_changed: 'A foto mudou durante a importação. O sistema tentará novamente.',
        rate_limited: 'Muitas fotos em pouco tempo. Aguarde um minuto.',
      })[code] || 'Não foi possível concluir. Atualize a tela e tente novamente.';
    },
  };
};
