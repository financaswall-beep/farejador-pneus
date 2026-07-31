export const TIRE_CONDITIONS = ['meia_vida', 'novo', 'remold'] as const;

export type TireCondition = (typeof TIRE_CONDITIONS)[number];

const aliases: Record<string, TireCondition> = {
  usado: 'meia_vida',
  meiavida: 'meia_vida',
  novo: 'novo',
  recapado: 'remold',
  remold: 'remold',
  remoldado: 'remold',
};

export function canonicalTireCondition(
  value: string | null | undefined,
): TireCondition | null {
  const key = (value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return key ? aliases[key] ?? null : null;
}

export function requireTireCondition(value: string | null | undefined): TireCondition {
  const condition = canonicalTireCondition(value);
  if (!condition) throw new Error('tire_condition_required');
  return condition;
}

export function tireConditionLabel(value: string | null | undefined): string {
  const condition = canonicalTireCondition(value);
  if (condition === 'meia_vida') return 'Meia-vida';
  if (condition === 'novo') return 'Novo';
  if (condition === 'remold') return 'Remold';
  return 'Revisar condição';
}
