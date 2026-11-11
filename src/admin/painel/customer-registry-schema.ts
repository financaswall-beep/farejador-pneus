import { z } from 'zod';
import { normalizeCheckoutPhone } from '../../shared/phone.js';
import { isPlaceholderCustomerName } from '../../shared/customer-name.js';

export const commercialProfileSchema = z.enum(['varejo','atacado','nao_classificado']);
export type CommercialProfile = z.infer<typeof commercialProfileSchema>;
const clean = (value: string) => value.normalize('NFC').trim().replace(/\s+/g,' ');
const text = (max: number) => z.string().transform(clean).pipe(z.string().max(max).regex(/^[^\x00-\x1f\x7f]*$/));
const ddDs = new Set('11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99'.split(' '));
export function registryPhone(raw: string): string | null {
  if (!raw.trim()) return null;
  const phone = normalizeCheckoutPhone(raw);
  if (!phone || !phone.startsWith('+55') || !ddDs.has(phone.slice(3,5))) throw new Error('Informe telefone brasileiro completo com DDD.');
  return phone;
}
export function validDocument(raw: string): boolean {
  const digits = raw.replace(/\D/g,'');
  if (!raw) return true;
  if (!/^[\d.\-/\s]+$/.test(raw) || ![11,14].includes(digits.length) || /^(\d)\1+$/.test(digits)) return false;
  const check = (base: string, weights: number[]) => {
    const rest = [...base].reduce((sum,d,i) => sum + Number(d) * weights[i]!,0) % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  if (digits.length === 11) return check(digits.slice(0,9),[10,9,8,7,6,5,4,3,2]) === Number(digits[9])
    && check(digits.slice(0,10),[11,10,9,8,7,6,5,4,3,2]) === Number(digits[10]);
  return check(digits.slice(0,12),[5,4,3,2,9,8,7,6,5,4,3,2]) === Number(digits[12])
    && check(digits.slice(0,13),[6,5,4,3,2,9,8,7,6,5,4,3,2]) === Number(digits[13]);
}
export const registryFields = z.object({
  name: text(160).refine(value => value.length >= 2 && /\p{L}/u.test(value) && !isPlaceholderCustomerName(value),'Informe o nome do cliente ou da empresa.'),
  commercial_profile: commercialProfileSchema,
  phone: z.string().max(40).transform((value,ctx) => {
    try { return registryPhone(value); } catch { ctx.addIssue({code:'custom',message:'Informe telefone completo com DDD.'}); return z.NEVER; }
  }),
  email: z.string().trim().toLowerCase().max(254).refine(value => !value || z.string().email().safeParse(value).success,'Informe um e-mail válido.'),
  document_number: z.string().trim().max(30).refine(validDocument,'CPF ou CNPJ inválido.').transform(value => value.replace(/\D/g,'')),
  postal_code: z.string().trim().max(10).regex(/^(?:\d{5}-?\d{3})?$/,'Informe CEP com oito dígitos.').transform(value => value.replace(/\D/g,'')),
  street: text(160), number: text(20), complement: text(100), neighborhood: text(100), city: text(100),
  state: z.string().trim().toUpperCase().refine(value => !value || 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ').includes(value),'Selecione uma UF válida.'),
}).strict();
export const createRegistrySchema = registryFields.extend({ idempotency_key:z.string().uuid() }).strict()
  .refine(value => value.commercial_profile !== 'nao_classificado',
    {path:['commercial_profile'],message:'Selecione Varejo ou Atacado para o novo cadastro.'});
export const updateRegistrySchema = registryFields.extend({ expected_version:z.number().int().min(0) }).strict();
export type RegistryFields = z.infer<typeof registryFields>;
