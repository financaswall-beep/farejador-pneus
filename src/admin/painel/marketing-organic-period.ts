/** Calendar days in the business timezone, starting with the publication day. */
export function organicPublicationWindow(publishedAt: string, id: '7d' | '30d') {
  const since = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date(publishedAt));
  const end = new Date(since + 'T12:00:00Z');
  end.setUTCDate(end.getUTCDate() + (id === '7d' ? 6 : 29));
  return { id, since, until: end.toISOString().slice(0, 10), timezone: 'America/Sao_Paulo' };
}
