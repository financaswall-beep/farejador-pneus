/**
 * Anel de proximidade que CRESCE — o coração geométrico da camada GEO.
 *
 * Ver docs/PLANO_CAMADA_GEO_PROXIMIDADE_REDE_2026-06-06.md §3 (pipeline) e §5.5.
 *
 * FUNÇÃO PURA — recebe candidatos JÁ ELEGÍVEIS (modo + estoque + cobertura já
 * filtrados pelo chamador) com uma distância por candidato, e escolhe o POOL:
 * todos os elegíveis dentro do MENOR anel que contém pelo menos um. Se ninguém
 * cabe nem no maior anel, devolve `onlyFar` (caso E — "só tem longe", §4) pro
 * chamador decidir com honestidade. NÃO ordena por "mais perto" dentro do anel:
 * isso é papel da régua de justiça (decisão D4) — aqui só FILTRA quem disputa.
 *
 * Princípio: proximidade FILTRA quem pode disputar; a justiça DECIDE quem ganha.
 */

/** Anéis de ENTREGA em km, crescentes (decisão D1: 10 → 20 → 30 → 40).
 *  Teto subiu de 30 → 40 km em 2026-06-08 (decisão Wallace): a Rede busca a loja
 *  mais perto que TEM o pneu até 40 km; acima disso cai na matriz (backstop). */
export const GEO_RING_KM = [10, 20, 30, 40] as const;

/** Raio MÁXIMO de RETIRADA em km (decisão D2: o cliente vai até a loja). Acima → matriz. */
export const GEO_PICKUP_RADIUS_KM = 15;

/** Anéis de RETIRADA, crescentes (decisão Wallace 2026-06-08: faixas de ~5 km).
 *  Igual à entrega, mas passo menor: a loja numa faixa MAIS PERTO ganha direto; lojas
 *  na MESMA faixa (~5 km) revezam pela régua. Resolve o "manda longe por justiça"
 *  (Cachambi: Méier a 2 km ganha; Méier-1/Méier-2 na mesma esquina revezam). Teto 15 km. */
export const GEO_PICKUP_RING_KM = [5, 10, 15] as const;

export interface RingSelection<T> {
  /** Elegíveis dentro do menor anel não-vazio (entram na régua de justiça). */
  pool: T[];
  /** Qual anel pegou o pool, em km; `null` = nada coube em nenhum anel. */
  ringKm: number | null;
  /**
   * Elegíveis que existem mas estão TODOS além do maior anel (caso E).
   * Ordenados por distância ASC (o mais perto dos longes primeiro). Só vem
   * preenchido quando `pool` está vazio.
   */
  onlyFar: T[];
}

/**
 * Escolhe o pool dentro do menor anel não-vazio, expandindo conforme necessário.
 * NÃO muta a entrada. Anéis fora de ordem são tratados como crescentes.
 *
 *  - elegíveis vazio        → { pool: [], ringKm: null, onlyFar: [] }
 *  - alguém dentro de um anel → { pool: <todos ≤ esse anel>, ringKm, onlyFar: [] }
 *  - todos além do maior anel → { pool: [], ringKm: null, onlyFar: <ASC por km> }
 *
 * O limite do anel é INCLUSIVO (distância ≤ raio).
 */
export function selectWithinExpandingRing<T>(
  eligible: T[],
  distanceKm: (item: T) => number,
  rings: readonly number[],
): RingSelection<T> {
  if (eligible.length === 0) {
    return { pool: [], ringKm: null, onlyFar: [] };
  }

  const sortedRings = [...rings].sort((a, b) => a - b);

  for (const ring of sortedRings) {
    const pool = eligible.filter((item) => distanceKm(item) <= ring);
    if (pool.length > 0) {
      return { pool, ringKm: ring, onlyFar: [] };
    }
  }

  // Nenhum anel pegou ninguém → todos os elegíveis estão além do maior anel.
  const onlyFar = [...eligible].sort((a, b) => distanceKm(a) - distanceKm(b));
  return { pool: [], ringKm: null, onlyFar };
}
