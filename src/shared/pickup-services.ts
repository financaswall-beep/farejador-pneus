import { z } from 'zod';

export const PICKUP_SERVICE_CATALOG = Object.freeze([
  { code: 'mounting', label: 'Montagem do pneu', matrixProductCode: 'PICKUP-SERVICE-MOUNTING' },
  { code: 'valve_change', label: 'Troca de bico', matrixProductCode: 'PICKUP-SERVICE-VALVE' },
  { code: 'balancing', label: 'Balanceamento', matrixProductCode: 'PICKUP-SERVICE-BALANCING' },
] as const);

export type PickupServiceCode = typeof PICKUP_SERVICE_CATALOG[number]['code'];
export type PickupServiceChargeMode = 'courtesy' | 'charged';

const serviceCodes = PICKUP_SERVICE_CATALOG.map((item) => item.code) as [
  PickupServiceCode, ...PickupServiceCode[],
];

export const pickupServiceSchema = z.object({
  code: z.enum(serviceCodes),
  charge_mode: z.enum(['courtesy', 'charged']),
  amount_cents: z.number().int().min(0).max(1_000_000),
}).superRefine((service, ctx) => {
  if (service.charge_mode === 'courtesy' && service.amount_cents !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'courtesy_service_must_be_zero' });
  }
  if (service.charge_mode === 'charged' && service.amount_cents <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'charged_service_amount_required' });
  }
});

export const pickupServicesSchema = z.array(pickupServiceSchema)
  .max(PICKUP_SERVICE_CATALOG.length, 'pickup_services_limit')
  .superRefine((services, ctx) => {
    const seen = new Set<string>();
    services.forEach((service, index) => {
      if (seen.has(service.code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'pickup_service_duplicate',
          path: [index, 'code'],
        });
      }
      seen.add(service.code);
    });
  });

export type PickupService = z.infer<typeof pickupServiceSchema>;

export function pickupServiceDefinition(code: PickupServiceCode) {
  return PICKUP_SERVICE_CATALOG.find((item) => item.code === code)!;
}

export function pickupServicesTotalCents(services: readonly PickupService[]): number {
  return services.reduce((total, service) => total + service.amount_cents, 0);
}

export function pickupServicesPublicCatalog() {
  return PICKUP_SERVICE_CATALOG.map(({ code, label }) => ({ code, label }));
}
