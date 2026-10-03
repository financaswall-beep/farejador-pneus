import type { PartnerContext } from './auth.js';

/** ID do login, nunca seu segredo. O vínculo persistido identifica a pessoa. */
export function partnerActor(ctx: PartnerContext): string {
  return `partner:${ctx.slug.slice(0, 120)}:token:${ctx.tokenId}`;
}
