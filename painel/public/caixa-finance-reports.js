(function () {
  'use strict';
  const C = window.Caixa, T = window.FarejadorTime, V = C.financeView, R = C.financeReportView, el = id => document.getElementById(id);
  let request, exportRequest, data = null, initialized = false, tab = 'result', direction = 'all', page = 0;
  const hide = (id, value) => el(id).classList.toggle('hidden', value);
  const allowed = () => C.token() && !C.isPartner() && C.canModule('financeiro');
  function exportButtons(disabled) { el('mr-pdf').disabled = disabled; el('mr-csv').disabled = disabled; }
  function cancel() { if (request) request.abort(); if (exportRequest) exportRequest.abort(); request = null; exportRequest = null; exportButtons(true); }
  function reset() { cancel(); data = null; initialized = false; tab = 'result'; direction = 'all'; page = 0; el('mr-content').classList.add('hidden'); el('mr-list').replaceChildren(); }
  function initialize() {
    if (initialized) return;
    const month = C.financeMatrix.period(), today = T.dateKey(new Date());
    el('mr-from').value = month + '-01';
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0, 15));
    el('mr-to').value = month === today.slice(0, 7) ? today : T.dateKey(last);
    ['mr-from', 'mr-to'].forEach(id => { el(id).max = today; });
    el('mr-origin').value = 'all'; el('mr-search').value = ''; el('mr-side').value = 'all'; el('mr-due').value = 'all'; initialized = true;
  }
  function filters() {
    return { from: el('mr-from').value, to: el('mr-to').value, mode: 'custom', origin: el('mr-origin').value, search: el('mr-search').value.trim(), view: tab,
      flow: 'realized', horizon: '30', direction, cash_day: '', result_kind: 'all', title_side: el('mr-side').value, due: el('mr-due').value };
  }
  function query(f) { return new URLSearchParams(f).toString(); }
  function validate(f) {
    const validDay = day => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day + 'T12:00:00Z').toISOString().slice(0, 10) === day;
    return validDay(f.from) && validDay(f.to) && f.from <= f.to && f.to <= T.dateKey(new Date()) && Date.parse(f.to) - Date.parse(f.from) <= 365 * 86400000;
  }
  function validateReport(body) {
    if (!body.summary || !body.position || !body.filters || !['green', 'yellow'].includes(body.integration_status)) throw Error('invalid_report');
    ['revenue', 'cost', 'expense', 'inventory_gain', 'inventory_loss', 'pending_revenue', 'result', 'opening', 'incoming', 'outgoing', 'closing'].forEach(key => V.number(body.summary[key]));
    ['receivable', 'payable', 'overdue_receivable', 'overdue_payable'].forEach(key => V.number(body.position[key]));
    ['result_rows', 'cash_rows', 'titles', 'expenses', 'origins', 'daily'].forEach(key => { if (!Array.isArray(body[key])) throw Error('invalid_report'); });
  }
  function errorMessage(status) {
    return status === 422 ? 'Muitos registros neste período. Selecione um intervalo menor.' : status === 400 ? 'Escolha um período válido de até 366 dias, encerrado até hoje.'
      : 'Não foi possível consultar o financeiro central. Toque em Atualizar para tentar novamente.';
  }
  function controls() {
    document.querySelectorAll('[data-mr-tab]').forEach(b => b.setAttribute('aria-current', b.dataset.mrTab === tab ? 'page' : 'false'));
    document.querySelectorAll('[data-mr-direction]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mrDirection === direction)));
    hide('mr-cash-controls', tab !== 'cash'); hide('mr-title-controls', tab !== 'titles');
  }
  async function load() {
    cancel(); if (!allowed()) return;
    initialize(); controls(); page = 0; data = null;
    hide('mr-content', true); hide('mr-error', true); hide('mr-loading', true); hide('mr-export-error', true);
    const f = filters();
    if (!validate(f)) { el('mr-error').textContent = errorMessage(400); hide('mr-error', false); return; }
    el('mr-period-label').textContent = T.formatDate(f.from).slice(0, 5) + ' – ' + T.formatDate(f.to);
    const controller = new AbortController(), session = C.sessionFingerprint(); request = controller; hide('mr-loading', false);
    try {
      const response = await C.authenticatedFetch('/api/caixa/financeiro-relatorios?' + query(f), { signal: controller.signal });
      if (!response.ok) throw Error(errorMessage(response.status));
      const body = await C.json(response);
      if (controller.signal.aborted || session !== C.sessionFingerprint()) return;
      validateReport(body); if (query(body.filters) !== query({ ...body.filters, ...f, horizon: Number(f.horizon) })) throw Error('invalid_report');
      data = body; R.render(data, tab); R.list(data, tab, page);
      el('mr-records').open = tab === 'cash' || tab === 'titles';
      hide('mr-content', false); exportButtons(false); C.financeMatrix.updated(new Date(body.as_of));
    } catch (error) {
      if (controller.signal.aborted || session !== C.sessionFingerprint() || error.message === 'invalid_session') return;
      el('mr-error').textContent = error.message === 'invalid_report' ? errorMessage(503) : error.message;
      hide('mr-error', false); hide('mr-content', true); data = null;
    } finally { if (request === controller) { request = null; hide('mr-loading', true); } }
  }
  function toggleFilters() {
    const open = el('mr-filters').classList.contains('hidden'); hide('mr-filters', !open);
    ['mr-period', 'mr-filter-toggle'].forEach(id => el(id).setAttribute('aria-expanded', String(open)));
  }
  async function download(format) {
    if (!data || request || exportRequest || !allowed()) return;
    const f = { ...data.filters }, controller = new AbortController(), session = C.sessionFingerprint();
    exportRequest = controller; exportButtons(true); hide('mr-export-error', true);
    try {
      const response = await C.authenticatedFetch('/api/caixa/financeiro-relatorios/' + (format === 'pdf' ? 'imprimir' : 'exportar') + '?' + query(f), { signal: controller.signal });
      if (!response.ok) throw Error(errorMessage(response.status));
      let blob;
      if (format === 'csv') blob = await response.blob();
      else {
        const report = await C.json(response); validateReport(report);
        const pdf = Object.assign(window.PAINEL_MODULES.relatoriosFinanceiroPdf(), {
          rpDate: value => value ? T.formatDate(value) : 'Sem data', rpMoney: V.money, rfinOrigin: R.origin, rfinTime: T.formatDateTime,
        });
        blob = new Blob([pdf.rfinPdfBytes(report, f.view)], { type: 'application/pdf' });
      }
      if (controller.signal.aborted || session !== C.sessionFingerprint()) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url;
      link.download = 'financeiro-' + f.view + '-' + f.from + '-' + f.to + '.' + format;
      document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (controller.signal.aborted || session !== C.sessionFingerprint() || error.message === 'invalid_session') return;
      el('mr-export-error').textContent = error.message === 'invalid_report' ? errorMessage(503) : error.message; hide('mr-export-error', false);
    } finally { if (exportRequest === controller) { exportRequest = null; exportButtons(!data); } }
  }
  ['mr-period', 'mr-filter-toggle'].forEach(id => el(id).addEventListener('click', toggleFilters));
  el('mr-filters').addEventListener('input', () => { cancel(); data = null; hide('mr-content', true); });
  el('mr-filters').addEventListener('submit', event => { event.preventDefault(); void load(); });
  el('mr-clear').addEventListener('click', () => { initialized = false; direction = 'all'; void load(); });
  ['mr-origin', 'mr-side', 'mr-due'].forEach(id => el(id).addEventListener('change', load));
  document.querySelectorAll('[data-mr-tab]').forEach(b => b.addEventListener('click', () => { tab = b.dataset.mrTab; el('mf-detail').close(); void load(); }));
  document.querySelectorAll('[data-mr-direction]').forEach(b => b.addEventListener('click', () => { direction = b.dataset.mrDirection; void load(); }));
  el('mr-prev').addEventListener('click', () => { if (data && page > 0) R.list(data, tab, --page); });
  el('mr-next').addEventListener('click', () => { if (data) R.list(data, tab, ++page); });
  el('mr-pdf').addEventListener('click', () => download('pdf')); el('mr-csv').addEventListener('click', () => download('csv'));
  C.financeReports = { load, cancel, reset };
}());
