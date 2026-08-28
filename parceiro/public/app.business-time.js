(function installFarejadorTime(global) {
  'use strict';

  const ZONE = 'America/Sao_Paulo';
  const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: ZONE, day: '2-digit', month: '2-digit', year: 'numeric',
  });
  const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: ZONE, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  const timeFormatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: ZONE, hour: '2-digit', minute: '2-digit',
  });

  function pureDate(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? { year: match[1], month: match[2], day: match[3] } : null;
  }

  function dateKey(value) {
    const plain = pureDate(value);
    if (plain) return `${plain.year}-${plain.month}-${plain.day}`;
    const instant = value instanceof Date ? value : new Date(value);
    return Number.isFinite(instant.getTime()) ? dateKeyFormatter.format(instant) : '';
  }

  function formatDate(value) {
    const plain = pureDate(value);
    if (plain) return `${plain.day}/${plain.month}/${plain.year}`;
    const instant = value instanceof Date ? value : new Date(value);
    return Number.isFinite(instant.getTime()) ? dateFormatter.format(instant) : '-';
  }

  function formatCivilDate(value) {
    const plain = pureDate(String(value || '').replace(/T00:00:00(?:\.000)?Z$/, ''));
    return plain ? `${plain.day}/${plain.month}/${plain.year}` : formatDate(value);
  }

  function formatDateTime(value) {
    if (!value) return '-';
    const instant = value instanceof Date ? value : new Date(value);
    return Number.isFinite(instant.getTime()) ? dateTimeFormatter.format(instant) : '-';
  }

  function formatTime(value) {
    if (!value) return '';
    const instant = value instanceof Date ? value : new Date(value);
    return Number.isFinite(instant.getTime()) ? timeFormatter.format(instant) : '';
  }

  function addDays(value, amount) {
    const plain = pureDate(value);
    if (!plain) return '';
    return new Date(Date.UTC(
      Number(plain.year), Number(plain.month) - 1, Number(plain.day) + amount,
    )).toISOString().slice(0, 10);
  }

  function weekBuckets(now = new Date(), count = 4) {
    const today = dateKey(now);
    return Array.from({ length: count }, (_, index) => {
      const endKey = addDays(today, -((count - 1 - index) * 7));
      const startKey = addDays(endKey, -6);
      return {
        startKey,
        endKey,
        label: `${formatDate(startKey).slice(0, 5)} - ${formatDate(endKey).slice(0, 5)}`,
      };
    });
  }

  function nextBoundary(frequency, now = new Date()) {
    const today = dateKey(now);
    const [year, month, day] = today.split('-').map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (frequency === 'weekly') return addDays(today, (7 - calendar.getUTCDay()) % 7);
    return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  }

  global.FarejadorTime = Object.freeze({
    ZONE, dateKey, businessDate: dateKey, formatDate, formatCivilDate, formatDateTime, formatTime,
    addDays, weekBuckets, nextBoundary,
  });
})(window);
