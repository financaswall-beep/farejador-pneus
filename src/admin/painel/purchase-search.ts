/** SQL fragment with a bound parameter index, shared by purchase rows and analytics. */
export function purchaseSearchClause(parameterIndex: number): string {
  const param = `$${parameterIndex}`;
  return `(lower(s.name) LIKE ${param}
    OR lower(p.id::text) LIKE ${param}
    OR lower(p.supplier_reference) LIKE ${param}
    OR EXISTS (SELECT 1 FROM commerce.wholesale_purchase_lines si
      WHERE si.environment=p.environment AND si.purchase_id=p.id
        AND lower(si.measure) LIKE ${param})
    OR EXISTS (SELECT 1 FROM commerce.wholesale_purchase_orders so
      WHERE so.environment=p.environment AND so.id=p.purchase_order_id
        AND lower('OC-'||to_char(so.created_at AT TIME ZONE 'America/Sao_Paulo','YYYY')
          ||'-'||lpad(so.order_number::text,6,'0')) LIKE ${param}))`;
}
