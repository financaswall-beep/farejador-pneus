(function () {
  'use strict';
  const C = window.Caixa;
  function sessionGuard(session) {
    if (session !== C.sessionFingerprint()) throw new Error('invalid_session');
  }
  async function api(path, method, session) {
    sessionGuard(session);
    const response = await C.authenticatedFetch(path, { method });
    const data = await C.json(response);
    sessionGuard(session);
    if (!response.ok) throw new Error(data.error || 'request_failed');
    return data;
  }
  /** UUID fica no objeto local: retry após timeout consulta o MESMO upload. */
  C.uploadPartnerTirePhoto = async function (requestId, photo, session) {
    if (!C.state.photoDirectUpload) {
      const response = await C.authenticatedFetch(C.photoUploadPath(requestId), {
        method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: photo.blob,
      });
      const data = await C.json(response);
      sessionGuard(session);
      if (!response.ok) throw new Error(data.error || 'request_failed');
      return data;
    }
    if (photo.blob.size > 2 * 1024 * 1024) throw new Error('photo_too_large');
    photo.uploadId = photo.uploadId || crypto.randomUUID();
    const base = C.operationPath('operacao/pedidos-foto/' + encodeURIComponent(requestId)
      + '/uploads/' + photo.uploadId);
    const reserved = await api(base + '/reserve', 'POST', session);
    if (reserved.state === 'ready') return { attached: true };
    if (reserved.state === 'rejected') throw new Error('photo_request_not_found');
    if (reserved.state === 'uploading') {
      sessionGuard(session);
      const response = await fetch(reserved.upload_url, {
        method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: photo.blob,
        credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(60000),
      });
      sessionGuard(session);
      // Upload imutável já presente após uma resposta perdida: validação lê os bytes do mesmo objeto.
      if (!response.ok && ![400,409].includes(response.status)) throw new Error('storage_upload_failed');
      await api(base + '/complete', 'POST', session);
    }
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const data = await api(base, 'GET', session);
      if (data.state === 'ready') return { attached: true };
      if (data.state === 'rejected') throw new Error('photo_request_not_found');
      await new Promise(resolve => window.setTimeout(resolve, 1500));
      sessionGuard(session);
    }
    throw new Error('photo_processing_timeout');
  };
}());
