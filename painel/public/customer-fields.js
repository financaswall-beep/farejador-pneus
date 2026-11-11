(function (root) {
  'use strict';
  const digits = value => String(value ?? '').replace(/\D/g, '');
  const ddds = new Set('11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99'.split(' '));
  function nationalPhone(value) {
    const raw = String(value ?? '').trim();
    if (!raw || !/^[+\d\s().-]+$/.test(raw)) return null;
    let n = digits(raw);
    if (n.startsWith('0055')) n = n.slice(2);
    if (n.startsWith('55') && [12,13].includes(n.length)) n = n.slice(2);
    else if (raw.startsWith('+')) return null;
    return ddds.has(n.slice(0,2)) && /^\d{2}(?:9\d{8}|[2-5]\d{7})$/.test(n) ? n : null;
  }
  function phone(value) {
    const n = nationalPhone(value);
    if (!n) return String(value ?? '').trim() || 'Não informado';
    return `(${n.slice(0,2)}) ${n.slice(2,-4)}-${n.slice(-4)}`;
  }
  function phoneMask(value) {
    const original = String(value ?? '');
    // Não corta números longos/internacionais: validação pede correção explícita.
    if (/[^+\d\s().-]/.test(original)) return original;
    let n = digits(original);
    if (n.startsWith('55') && [12,13].includes(n.length)) n = n.slice(2);
    if (n.length > 11 || original.startsWith('+') && !original.startsWith('+55')) return original;
    if (n.length < 3) return n;
    const split = n.length > 10 ? 7 : 6;
    return `(${n.slice(0,2)}) ${n.slice(2,split)}${n.length > split ? '-'+n.slice(split) : ''}`;
  }
  function documentMask(value) {
    const raw = String(value ?? '');
    if (/[^\d.\-/\s]/.test(raw) || digits(raw).length > 14) return raw;
    const n = digits(raw);
    return n.length <= 11 ? n.replace(/^(\d{3})(\d)/,'$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/,'$1.$2.$3').replace(/(\d{3})\.(\d{3})\.(\d{3})(\d)/,'$1.$2.$3-$4')
      : n.replace(/^(\d{2})(\d)/,'$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/,'$1.$2.$3').replace(/(\d{3})(\d{4})/,'$1/$2').replace(/(\d{4})(\d{1,2})$/,'$1-$2');
  }
  root.CustomerFields = Object.freeze({digits,nationalPhone,phone,phoneMask,documentMask,
    postalMask(value) { const raw = String(value ?? ''); return /^[\d-]*$/.test(raw) && digits(raw).length <= 8 ? digits(raw).replace(/^(\d{5})(\d)/,'$1-$2') : raw; },
    clean(value) { return String(value ?? '').normalize('NFC').trim().replace(/\s+/g,' '); }});
})(window);
