export const WHOLESALE_CONTACT = {
  name: '2W Pneus — Atacado',
  phone: '5521976674264',
  displayPhone: '(21) 97667-4264',
  url: 'https://wa.me/5521976674264',
} as const;

export const WHOLESALE_CARD_TEXT = [
  WHOLESALE_CONTACT.name, WHOLESALE_CONTACT.displayPhone, WHOLESALE_CONTACT.url,
].join('\n');

export const WHOLESALE_INTRO = 'Claro! Vou te passar o contato de quem cuida do atacado aqui na 2W. Pode chamar por este WhatsApp.';

/** Se o modelo responder só com o contato, o cliente ainda recebe a apresentação. */
export function introduceBareWholesaleContact(body: string): string {
  const contact = body.trim().replace(/^(?:WhatsApp|Atacado|Contato do atacado)\s*:\s*/i, '');
  const phone = contact.replace(WHOLESALE_CONTACT.url, '').replace(/[\s()+.<>-]/g, '');
  const isBareLink = contact.includes(WHOLESALE_CONTACT.url) && phone === '';
  if (isBareLink || phone === WHOLESALE_CONTACT.phone || phone === WHOLESALE_CONTACT.phone.slice(2)) {
    return `${WHOLESALE_INTRO}\n${WHOLESALE_CONTACT.url}`;
  }
  return body;
}
