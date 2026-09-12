import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';

export interface NeighborhoodCandidate {
  city_name: string;
  neighborhood_canonical: string;
  city_resolution_priority: number;
  match_similarity?: number;
}

export function normalizePlace(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export class AmbiguousNeighborhoodError extends Error {
  constructor(readonly bairro: string, readonly municipios: string[]) {
    super('municipio_ambiguo');
  }

  response() {
    return {
      erro: 'municipio_ambiguo', precisa_municipio: true,
      bairro: this.bairro, municipios_possiveis: this.municipios,
      orientacao: 'Pergunte somente em qual cidade fica esse bairro. Use os municípios retornados quando forem duas opções; com mais opções, faça uma pergunta curta sobre a cidade. Preserve o pneu e os dados já informados. Não confirme estoque, preço, frete ou loja até resolver a cidade. Não peça novamente endereço ou pino.',
    };
  }
}

/** Exact e aliases são considerados juntos: um exact não pode esconder
 * o mesmo nome cadastrado como alias em outra cidade. Fuzzy é só fallback. */
export async function findNeighborhoodCandidates(
  client: PoolClient, environment: Environment, bairro: string, municipio?: string | null,
): Promise<NeighborhoodCandidate[]> {
  const input = bairro.trim();
  if (!input) return [];
  const city = municipio?.trim() || null;
  const exact = await client.query<NeighborhoodCandidate>(
    `SELECT g.city_name,g.neighborhood_canonical,g.city_resolution_priority
       FROM commerce.geo_resolutions g
      WHERE g.environment=$1
        AND ($3::text IS NULL OR lower(unaccent(g.city_name))=lower(unaccent($3)))
        AND (lower(unaccent(g.neighborhood_canonical))=lower(unaccent($2))
          OR lower(unaccent($2))=ANY(SELECT lower(unaccent(unnest(g.aliases)))))`,
    [environment, input, city],
  );
  if (exact.rows.length) return exact.rows;
  return (await client.query<NeighborhoodCandidate>(
    `SELECT g.city_name,g.neighborhood_canonical,g.city_resolution_priority,
            similarity(unaccent(g.neighborhood_canonical),unaccent($2)) AS match_similarity
       FROM commerce.geo_resolutions g
      WHERE g.environment=$1
        AND ($3::text IS NULL OR lower(unaccent(g.city_name))=lower(unaccent($3)))
        AND similarity(unaccent(g.neighborhood_canonical),unaccent($2))>0.4`,
    [environment, input, city],
  )).rows;
}

export function chooseNeighborhoodCity(bairro: string, candidates: NeighborhoodCandidate[]): string | null {
  const cities = new Map<string, { name: string; priority: number }>();
  const bestSimilarity = Math.max(...candidates.map(row => Number(row.match_similarity ?? 1)));
  for (const row of candidates) {
    const key = normalizePlace(row.city_name);
    const previous = cities.get(key);
    const priority = Number(row.match_similarity ?? 1) === bestSimilarity ? Number(row.city_resolution_priority) || 0 : 0;
    cities.set(key, { name: row.city_name, priority: Math.max(previous?.priority ?? 0, priority) });
  }
  if (!cities.size) return null;
  if (cities.size === 1) return [...cities.values()][0]!.name;
  const values = [...cities.values()];
  const top = Math.max(...values.map(row => row.priority));
  const preferred = values.filter(row => row.priority === top);
  if (top > 0 && preferred.length === 1) return preferred[0]!.name;
  throw new AmbiguousNeighborhoodError(bairro, values.map(row => row.name).sort((a,b) => a.localeCompare(b, 'pt-BR')));
}

export async function resolveNeighborhoodCity(
  client: PoolClient, environment: Environment, bairro: string, municipio?: string | null,
): Promise<string | null> {
  return chooseNeighborhoodCity(bairro, await findNeighborhoodCandidates(client, environment, bairro, municipio));
}
