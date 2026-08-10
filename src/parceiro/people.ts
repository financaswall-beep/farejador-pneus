/**
 * Conta da PESSOA — porta única de login (0095).
 *
 * A pessoa (network.partner_people) tem username único NA REDE (por environment)
 * e UMA senha; os vínculos com lojas vivem em partner_access_tokens.person_id
 * (papel owner/funcionario por unidade). Este módulo autentica a PESSOA e lista
 * as lojas DELA — nunca "lojas onde a senha coincidiu" (senha igual de outra
 * pessoa não mistura: a conta é outra).
 *
 * Tudo via pool ADMIN, mesmo regime do login por slug (authenticatePartnerLogin):
 * o pool restrito do portal não tem GRANT em partner_people/access_tokens.
 */

import { pool } from '../persistence/db.js';
import { fakeVerify, verifyPassword } from './password.js';

export interface PersonStore {
  token_id: string;
  slug: string;
  store_name: string;
  role: string;
}

export interface PersonAuthResult {
  personId: string;
  stores: PersonStore[];
}

export interface PersonCredentialsResult {
  personId: string;
  username: string;
}

/**
 * Confere a identidade global sem presumir onde a pessoa trabalha.
 * A porta do parceiro lista lojas depois desta etapa; a Operação da Loja também
 * pode acrescentar o vínculo ativo com a Matriz sem conferir a senha duas vezes.
 */
export async function authenticatePersonCredentials(
  environment: string,
  username: string,
  password: string,
): Promise<PersonCredentialsResult | null> {
  const res = await pool.query<{ id: string; username: string; password_hash: string | null }>(
    `SELECT id, username, password_hash
       FROM network.partner_people
      WHERE environment = $1
        AND lower(username) = lower($2)
        AND revoked_at IS NULL
        AND password_hash IS NOT NULL
      LIMIT 1`,
    [environment, username.trim()],
  );

  const person = res.rows[0];
  if (!person) {
    await fakeVerify(password);
    return null;
  }
  if (!await verifyPassword(password, person.password_hash)) return null;
  return { personId: person.id, username: person.username };
}

/**
 * Autentica a pessoa (username global + senha). null em: pessoa inexistente,
 * senha errada OU pessoa sem loja ativa — sempre a MESMA resposta lá fora
 * (não revela o que falhou). Pessoa inexistente queima o tempo de um verify
 * real (anti-enumeração por timing, igual ao login por slug).
 */
export async function authenticatePersonGlobal(
  environment: string,
  username: string,
  password: string,
): Promise<PersonAuthResult | null> {
  const person = await authenticatePersonCredentials(environment, username, password);
  if (!person) return null;
  const stores = await listPersonStores(environment, person.personId);
  if (stores.length === 0) return null; // sem loja ativa = mesma cara de credencial inválida
  return { personId: person.personId, stores };
}

/** Lojas ATIVAS da pessoa (vínculos não-revogados em unidade/parceiro ativos). */
export async function listPersonStores(environment: string, personId: string): Promise<PersonStore[]> {
  const res = await pool.query<PersonStore>(
    `SELECT pat.id AS token_id,
            pu.slug,
            COALESCE(pu.display_name, u.name) AS store_name,
            pat.role
       FROM network.partner_access_tokens pat
       JOIN network.partner_units pu ON pu.id = pat.partner_unit_id AND pu.environment = pat.environment
       JOIN network.partners p ON p.id = pu.partner_id AND p.environment = pu.environment
       JOIN core.units u ON u.id = pu.unit_id
      WHERE pat.environment = $1
        AND pat.person_id = $2
        AND pat.revoked_at IS NULL
        AND pu.status = 'active' AND p.status = 'active'
        AND pu.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY store_name ASC`,
    [environment, personId],
  );
  return res.rows;
}
