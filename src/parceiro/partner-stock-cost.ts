const COST_SCALE = 1_000_000n;

function scaled(value: string | number | null): bigint {
  const raw = String(value ?? '0').trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error('purchase_stock_cost_invalid');
  const [whole, fraction = ''] = raw.split('.');
  const padded = (fraction + '0000000').slice(0, 7);
  let result = BigInt(whole!) * COST_SCALE + BigInt(padded.slice(0, 6));
  if (Number(padded[6]) >= 5) result += 1n;
  return result;
}

function decimal(value: bigint): string {
  const whole = value / COST_SCALE;
  const fraction = (value % COST_SCALE).toString().padStart(6, '0');
  return `${whole}.${fraction}`;
}

function roundedDivide(value: bigint, divisor: bigint): bigint {
  return (value + divisor / 2n) / divisor;
}

export interface PurchaseStockCostReversal {
  next_quantity: number;
  next_average_cost: string;
  current_value: string;
  reversed_value: string;
  next_value_before_average_rounding: string;
  next_value_after_average_rounding: string;
  rounding_residual: string;
}

export function addPurchaseStockCost(input: {
  current_quantity: number;
  current_average_cost: string | number | null;
  received_quantity: number;
  purchase_unit_cost: string | number;
}): { next_quantity: number; next_average_cost: string } {
  if (!Number.isInteger(input.current_quantity) || input.current_quantity < 0
      || !Number.isInteger(input.received_quantity) || input.received_quantity <= 0) {
    throw new Error('purchase_stock_quantity_invalid');
  }
  if (input.current_quantity > 0 && input.current_average_cost == null) {
    throw new Error('purchase_receipt_existing_cost_missing');
  }
  const currentQuantity = BigInt(input.current_quantity);
  const receivedQuantity = BigInt(input.received_quantity);
  const nextQuantity = input.current_quantity + input.received_quantity;
  const nextValue = currentQuantity * scaled(input.current_average_cost)
    + receivedQuantity * scaled(input.purchase_unit_cost);
  return {
    next_quantity: nextQuantity,
    next_average_cost: decimal(roundedDivide(nextValue, BigInt(nextQuantity))),
  };
}

/**
 * Reverte do custo medio o valor causal de uma compra cancelada.
 * As contas usam inteiros com seis casas para não depender de ponto flutuante.
 */
export function reversePurchaseStockCost(input: {
  current_quantity: number;
  current_average_cost: string | number | null;
  reversed_quantity: number;
  purchase_unit_cost: string | number;
}): PurchaseStockCostReversal {
  if (!Number.isInteger(input.current_quantity) || input.current_quantity < 0
      || !Number.isInteger(input.reversed_quantity) || input.reversed_quantity <= 0) {
    throw new Error('purchase_stock_quantity_invalid');
  }
  if (input.current_quantity < input.reversed_quantity) {
    throw new Error('purchase_stock_quantity_insufficient');
  }
  const currentAverage = scaled(input.current_average_cost);
  const purchaseCost = scaled(input.purchase_unit_cost);
  const currentQuantity = BigInt(input.current_quantity);
  const reversedQuantity = BigInt(input.reversed_quantity);
  const nextQuantity = input.current_quantity - input.reversed_quantity;
  const currentValue = currentQuantity * currentAverage;
  const reversedValue = reversedQuantity * purchaseCost;
  const wantedNextValue = currentValue - reversedValue;
  if (nextQuantity > 0 && wantedNextValue < 0n) {
    throw new Error('purchase_stock_value_insufficient');
  }

  // Saldo zero não carrega valor contábil; preservamos o último custo informativo.
  const nextAverage = nextQuantity === 0
    ? currentAverage
    : roundedDivide(wantedNextValue, BigInt(nextQuantity));
  const storedNextValue = BigInt(nextQuantity) * nextAverage;
  return {
    next_quantity: nextQuantity,
    next_average_cost: decimal(nextAverage),
    current_value: decimal(currentValue),
    reversed_value: decimal(reversedValue),
    next_value_before_average_rounding: decimal(nextQuantity === 0 ? 0n : wantedNextValue),
    next_value_after_average_rounding: decimal(storedNextValue),
    rounding_residual: decimal(
      (nextQuantity === 0 ? 0n : wantedNextValue) >= storedNextValue
        ? (nextQuantity === 0 ? 0n : wantedNextValue) - storedNextValue
        : storedNextValue - (nextQuantity === 0 ? 0n : wantedNextValue),
    ),
  };
}
