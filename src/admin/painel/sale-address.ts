import { z } from 'zod';
const text = z.string().trim().max(160).transform(value => value.replace(/\s+/g, ' '));
export const saleAddressSchema = z.object({
  street: text.pipe(z.string().min(1)), number: text, no_number: z.boolean(),
  complement: text, district: text.pipe(z.string().min(1)), city: text.pipe(z.string().min(1)),
  uf: z.enum(['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']),
  cep: z.string().regex(/^(?:\d{5}-?\d{3})?$/),
}).strict().refine(a => a.no_number || Boolean(a.number), { message:'sale_address_number_required',path:['number'] });
export type SaleAddress = z.infer<typeof saleAddressSchema>;
export function formatSaleAddress(input: SaleAddress): string {
  const a = saleAddressSchema.parse(input);
  return [a.street,a.no_number?'s/n':a.number,a.complement,a.district,`${a.city} - ${a.uf}`,a.cep].filter(Boolean).join(', ');
}
