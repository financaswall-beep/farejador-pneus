(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  function normalizeMeasure(value) {
    const text = value.trim().replace(/\s+/g, '');
    const candidates = /^\d{6,8}$/.test(text)
      ? [2, 3].flatMap(width => [2, 3].filter(profile => width + profile + 2 === text.length)
        .map(profile => text.slice(0, width) + '/' + text.slice(width, width + profile) + '-' + text.slice(-2)))
      : [text];
    const measures = [...new Set(candidates.flatMap(candidate => {
      const match = /^(\d{2,3})\/(\d{2,3})(?:-|R)(\d{2})$/i.exec(candidate);
      if (!match) return [];
      const [width, profile, rim] = match.slice(1).map(Number);
      return width >= 50 && width <= 400 && profile >= 20 && profile <= 100 && rim >= 8 && rim <= 30
        ? [width + '/' + profile + '-' + rim] : [];
    }))];
    return measures.length === 1 ? measures[0] : null;
  }
  function measure(input, container) {
    const hint = U.node('p', null, 'ps-stock-measure-hint'); hint.hidden = true;
    hint.setAttribute('aria-live', 'polite'); container.appendChild(hint);
    function validate() {
      const original = input.value.trim(); const normalized = normalizeMeasure(original);
      input.setCustomValidity?.(normalized ? '' : 'Confira a medida, como 90/90-18 ou 195/65-15.');
      if (normalized) {
        input.value = normalized;
        if (original !== normalized) {
          const check = U.icon('check'); check.setAttribute('aria-hidden', 'true');
          hint.replaceChildren(check, U.node('span', original + ' → ' + normalized)); hint.hidden = false;
        }
      }
      return Boolean(normalized);
    }
    input.addEventListener('blur', validate);
    input.addEventListener('input', () => { input.setCustomValidity?.(''); hint.hidden = true; });
    return validate;
  }
  function vehicle(container) {
    const group = U.node('fieldset', null, 'ps-stock-condition ps-stock-vehicle');
    group.appendChild(U.node('legend', 'Pneu de'));
    const choices = U.node('div', null, 'ps-stock-condition-options');
    const paths = {
      car: 'M3 13l2-6h14l2 6v6H3ZM3 13h18M7 7l2-3h6l2 3M6 16h2m8 0h2M5 19v2m14-2v2',
      motorcycle: 'M7 17a4 4 0 1 0-8 0 4 4 0 0 0 8 0Zm17 0a4 4 0 1 0-8 0 4 4 0 0 0 8 0ZM3 17l5-8 6 8H3Zm5-8h8l4 8M15 4h3l2 8M6 6h4',
    };
    const radios = ['car', 'motorcycle'].map(value => {
      const label = U.node('label', null, 'ps-stock-condition-choice');
      const radio = U.node('input'); radio.type = 'radio'; radio.name = 'vehicle_type'; radio.value = value;
      radio.required = true; radio.checked = value === 'motorcycle';
      const symbol = C.createSvg([{ d: paths[value] }]); symbol.classList.add('ps-stock-vehicle-icon'); symbol.setAttribute('aria-hidden', 'true');
      const check = U.icon('check'); check.setAttribute('aria-hidden', 'true');
      label.append(radio, symbol, check, U.node('span', value === 'car' ? 'Carro' : 'Moto'));
      choices.appendChild(label); return radio;
    });
    group.appendChild(choices); container.appendChild(group);
    return () => radios.find(radio => radio.checked)?.value;
  }
  function brand(container, page) {
    const wrap = U.node('div', null, 'ps-field'); const caption = U.node('span', 'Marca');
    const input = U.node('input'); input.type = 'hidden'; input.name = 'brand';
    const trigger = U.node('button', null, 'ps-stock-brand-trigger'); trigger.type = 'button';
    trigger.setAttribute('aria-label', 'Marca'); trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
    const selected = U.node('span', 'Escolha a marca');
    const arrow = C.createSvg([{ d: 'm5 9 7 7 7-7' }]); arrow.setAttribute('aria-hidden', 'true');
    trigger.append(selected, arrow); wrap.append(caption, input, trigger); container.appendChild(wrap);
    const dialog = U.node('dialog', null, 'ps-brand-dialog'); dialog.setAttribute('aria-labelledby', 'ps-brand-title');
    const sheet = U.node('div', null, 'ps-brand-sheet');
    ['tl', 'tr', 'bl', 'br'].forEach(corner => { const screw = U.node('i', null, 'ps-stock-screw ps-stock-screw--' + corner); screw.setAttribute('aria-hidden', 'true'); sheet.appendChild(screw); });
    const header = U.node('header', null, 'ps-brand-heading'); const title = U.node('h3', 'Escolha a marca'); title.id = 'ps-brand-title';
    const close = U.node('button', '×', 'ps-brand-close'); close.type = 'button'; close.setAttribute('aria-label', 'Fechar marcas');
    close.addEventListener('click', () => dialog.close()); header.append(title, close);
    const searchWrap = U.node('label', null, 'ps-stock-search');
    const magnifier = C.createSvg([{ d: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6' }]); magnifier.setAttribute('aria-hidden', 'true');
    const search = U.node('input'); search.type = 'search'; search.placeholder = 'Buscar marca'; search.setAttribute('aria-label', 'Buscar marca'); search.autocomplete = 'off';
    searchWrap.append(magnifier, search);
    const list = U.node('div', null, 'ps-brand-list'); list.setAttribute('aria-label', 'Marcas disponíveis');
    function render() {
      const query = search.value.trim().toLocaleLowerCase('pt-BR');
      const popular = ['Pirelli', 'Michelin', 'Levorin', 'Rinaldi', 'Technic'];
      const brands = [...new Set([input.value, ...popular, ...C.catalogBrandOptions])]
        .filter(name => C.catalogBrandOptions.includes(name) && name.toLocaleLowerCase('pt-BR').includes(query));
      list.replaceChildren();
      brands.forEach(name => {
        const row = U.node('button', null, 'ps-brand-option'); row.type = 'button'; row.setAttribute('aria-label', name);
        row.setAttribute('aria-pressed', String(input.value === name)); row.appendChild(U.node('span', name));
        if (input.value === name) { const check = U.icon('check'); check.setAttribute('aria-hidden', 'true'); row.appendChild(check); }
        row.addEventListener('click', () => { input.value = name; selected.textContent = name; dialog.close(); });
        list.appendChild(row);
      });
      if (!brands.length) list.appendChild(U.node('p', 'Nenhuma marca encontrada.', 'ps-brand-empty'));
    }
    function open() {
      if (trigger.disabled || !C.isPartner() || !C.canModule('estoque')) return;
      search.value = ''; render(); dialog.showModal(); trigger.setAttribute('aria-expanded', 'true');
      // Evita abrir o teclado antes de o parceiro precisar buscar.
      close.focus();
    }
    search.addEventListener('input', render); trigger.addEventListener('click', open);
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => { trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); });
    sheet.append(header, searchWrap, list); dialog.appendChild(sheet); page.appendChild(dialog);
    return { input, open, close: () => { if (dialog.open) dialog.close(); } };
  }
  C.partnerStockFields = { normalizeMeasure, measure, vehicle, brand };
}());
