import { z } from 'zod';
import { NETWORK_MUNICIPALITIES, resolveNetworkMunicipality } from './municipality-catalog.js';

export const networkMunicipalityNameSchema = z.string().trim().min(1).transform((value, ctx) => {
  const municipality = resolveNetworkMunicipality(value);
  if (!municipality) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'municipio_nao_reconhecido',
    });
    return z.NEVER;
  }
  return municipality.name;
});

export const networkMunicipalitiesSchema = z
  .array(networkMunicipalityNameSchema)
  .min(1, 'municipio_obrigatorio')
  .max(NETWORK_MUNICIPALITIES.length, 'municipios_demais')
  .transform((municipalities) => [...new Set(municipalities)]);

export const networkMunicipalitiesTextSchema = z.string().trim().min(1, 'municipio_obrigatorio')
  .max(2000)
  .transform((value, ctx) => {
    const parsed = networkMunicipalitiesSchema.safeParse(
      value.split(',').map((municipality) => municipality.trim()).filter(Boolean),
    );
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: parsed.error.issues[0]?.message ?? 'municipio_nao_reconhecido',
      });
      return z.NEVER;
    }
    return parsed.data.join(', ');
  });
