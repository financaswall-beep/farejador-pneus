// Contas 2W autorizadas pelo dono para comentários e atribuição de anúncios.
// Um ID vindo de variável ou webhook não pode ampliar este escopo.
export const META_BUSINESS_ACCOUNTS = Object.freeze({
  facebook: Object.freeze({ id: '1434857906367394', label: '2W Pneus' }),
  instagram: Object.freeze({ id: '17841465774227389', label: '@2wp.pneus' }),
});

export function isAuthorizedMetaMessagingAccount(
  channel: 'messenger' | 'instagram',
  businessAccountId: string | null,
): boolean {
  return businessAccountId === (channel === 'messenger'
    ? META_BUSINESS_ACCOUNTS.facebook.id
    : META_BUSINESS_ACCOUNTS.instagram.id);
}
