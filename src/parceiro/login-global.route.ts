/**
 * PORTA ÚNICA DE LOGIN — /login (0095, decisão do dono 2026-06-11).
 *
 * Uma URL só pra rede inteira: a pessoa digita usuário+senha → o sistema acha a
 * CONTA dela (network.partner_people, username único na rede) → 1 loja entra
 * direto; N lojas devolve um ticket de 2 min e o front mostra "escolhe a loja"
 * (só as lojas DELA — papel de cada vínculo decide o que vê lá dentro).
 *
 * O login por slug (/parceiro/:slug/ + api/login) CONTINUA funcionando — esta
 * rota é aditiva; a sessão emitida aqui é a MESMA do caminho antigo
 * (mintPartnerSession), então o painel não muda nada.
 *
 * Segurança (espelha o login por slug + endurece o global):
 *   - resposta ÚNICA 401 invalid_credentials (usuário inexistente, senha errada
 *     e pessoa sem loja têm a MESMA cara; timing também — fakeVerify).
 *   - rate-limit GLOBAL por IP (porta única concentra brute-force) + por
 *     username (protege uma conta de ataque distribuído... por IP igual).
 *   - ticket de escolha: uso único, 2 min, hash em memória; nunca expõe token_id.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { env } from '../shared/config/env.js';
import { rateLimitHit } from './rate-limit.js';
import { authenticatePersonGlobal } from './people.js';
import { consumeLoginTicket, newLoginTicket } from './login-ticket.js';
import { mintPartnerSession } from './queries.js';

const publicDir = path.join(process.cwd(), 'parceiro', 'public');

// Mesmos limites do login por slug (route.ts): 10 tentativas / 5 min por chave.
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
// Teto por IP mais folgado: na porta única o MESMO IP legítimo pode errar em
// mais de uma conta (ex.: dono ajudando funcionário); 20 cobre sem abrir flood.
const LOGIN_MAX_PER_IP = 20;

// Espelho dos fields do route.ts (mesma régua de formato do username/senha).
const usernameField = z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, 'usuario_invalido');
const passwordField = z.string().min(6).max(200);

const loginSchema = z.object({
  username: usernameField,
  password: passwordField,
});

const escolherSchema = z.object({
  ticket: z.string().regex(/^lt_[a-f0-9]{64}$/),
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/),
});

async function sendStatic(reply: FastifyReply, file: string, type: string) {
  const content = await readFile(path.join(publicDir, file));
  return reply.header('Content-Type', type).header('Cache-Control', 'no-store').send(content);
}

export async function registerLoginGlobalRoute(fastify: FastifyInstance): Promise<void> {
  // A página (pública, standalone — CSS embutido, sem tocar no painel).
  fastify.get('/login', async (_request, reply) => sendStatic(reply, 'login.html', 'text/html; charset=utf-8'));
  fastify.get('/login.js', async (_request, reply) => sendStatic(reply, 'login.js', 'text/javascript; charset=utf-8'));

  // Passo 1: usuário+senha → sessão direta (1 loja) ou ticket de escolha (N lojas).
  fastify.post('/api/login', async (request, reply) => {
    if (rateLimitHit(`glogin:ip:${request.ip}`, LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS)) {
      return reply.status(429).send({ error: 'too_many_attempts' });
    }
    const parsed = loginSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(401).send({ error: 'invalid_credentials' });
    if (rateLimitHit(`glogin:user:${parsed.data.username.toLowerCase()}`, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS)) {
      return reply.status(429).send({ error: 'too_many_attempts' });
    }

    const auth = await authenticatePersonGlobal(env.FAREJADOR_ENV, parsed.data.username, parsed.data.password);
    if (!auth) return reply.status(401).send({ error: 'invalid_credentials' });

    if (auth.stores.length === 1) {
      const store = auth.stores[0]!;
      const session = await mintPartnerSession(env.FAREJADOR_ENV, store.token_id);
      return reply.status(200).send({
        mode: 'direct',
        slug: store.slug,
        store_name: store.store_name,
        session_token: session.session_token,
        expires_at: session.expires_at,
      });
    }

    const ticket = newLoginTicket(env.FAREJADOR_ENV, auth.personId, auth.stores);
    return reply.status(200).send({
      mode: 'choose',
      ticket,
      // Sem token_id: o front só precisa de slug+nome+papel pra desenhar os cards.
      stores: auth.stores.map((s) => ({ slug: s.slug, store_name: s.store_name, role: s.role })),
    });
  });

  // Passo 2: troca o ticket (uso único) pela sessão da loja escolhida.
  fastify.post('/api/login/escolher', async (request, reply) => {
    if (rateLimitHit(`glogin:ip:${request.ip}`, LOGIN_MAX_PER_IP, LOGIN_WINDOW_MS)) {
      return reply.status(429).send({ error: 'too_many_attempts' });
    }
    const parsed = escolherSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(401).send({ error: 'ticket_invalid' });

    const data = consumeLoginTicket(parsed.data.ticket);
    if (!data || data.environment !== env.FAREJADOR_ENV) {
      return reply.status(401).send({ error: 'ticket_invalid' });
    }
    const store = data.stores.find((s) => s.slug === parsed.data.slug);
    if (!store) return reply.status(401).send({ error: 'ticket_invalid' });

    const session = await mintPartnerSession(env.FAREJADOR_ENV, store.token_id);
    return reply.status(200).send({
      slug: store.slug,
      store_name: store.store_name,
      session_token: session.session_token,
      expires_at: session.expires_at,
    });
  });
}
