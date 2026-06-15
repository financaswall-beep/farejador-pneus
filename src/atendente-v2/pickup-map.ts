/**
 * GARANTIA DO MAPA NA RETIRADA — pós-processador determinístico (decisão Wallace 2026-06-14).
 *
 * Sintoma real (PED-0044): o resumo da RETIRADA deve trazer o link do Google Maps da loja
 * (pra o cliente saber como chegar), mas quem ESCREVE o resumo é o LLM seguindo o prompt — e
 * prompt é probabilístico (§3 do CLAUDE.md): às vezes o bot "amolece" e o link some.
 *
 * Conserto (garantido por CÓDIGO, não por prompt): depois que o LLM monta a resposta e ANTES
 * de enviar ao Chatwoot (ver agent.ts), olhamos o resultado do criar_pedido deste turno. Se
 * fechou uma RETIRADA com maps_url e o texto NÃO contém o link, anexamos o link sozinho numa
 * linha (o WhatsApp renderiza o preview clicável). Idempotente: se o link já está lá, nada muda.
 * Só vale pra RETIRADA — na ENTREGA a loja vai até o cliente, não entra endereço de loja.
 *
 * Funções PURAS (sem pool/env) → testáveis sem carregar ambiente, igual ao satisfaction-rating.ts.
 */

export interface PickupCard {
  nome_loja: string;
  endereco: string | null;
  maps_url: string | null;
}

interface ActionToolCall {
  id: string;
  function: { name: string };
}

interface ActionMessage {
  role: string;
  content?: string | null;
  tool_calls?: ActionToolCall[];
  tool_call_id?: string;
}

/**
 * Acha o cartão da loja de RETIRADA no resultado do criar_pedido deste turno. Casa o
 * tool_call "criar_pedido" (na mensagem do assistant) com o seu tool result (pelo
 * tool_call_id) e lê o campo `retirada`. Pega o ÚLTIMO criar_pedido se houver retry no
 * turno. Devolve null se não houve retirada com loja (entrega, matriz sem cartão, ou
 * JSON inesperado — tudo fail-safe).
 */
export function extractPickupCardFromActions(actions: readonly ActionMessage[]): PickupCard | null {
  // 1. id do tool_call de criar_pedido (último, se houver mais de um no turno)
  let criarId: string | null = null;
  for (const m of actions) {
    const tc = m.tool_calls?.find((t) => t.function?.name === 'criar_pedido');
    if (tc) criarId = tc.id;
  }
  if (!criarId) return null;

  // 2. o tool result correspondente (mesmo tool_call_id)
  const resultMsg = actions.find((m) => m.role === 'tool' && m.tool_call_id === criarId);
  if (!resultMsg?.content) return null;

  // 3. lê o cartão da retirada (fail-safe em JSON inesperado)
  try {
    const parsed = JSON.parse(resultMsg.content) as {
      retirada?: { nome_loja?: string | null; endereco?: string | null; maps_url?: string | null } | null;
    };
    const r = parsed.retirada;
    if (!r || !r.nome_loja) return null;
    return { nome_loja: r.nome_loja, endereco: r.endereco ?? null, maps_url: r.maps_url ?? null };
  } catch {
    return null;
  }
}

/**
 * Garante o link do Maps no texto do resumo da retirada. Se há cartão com maps_url e o
 * texto ainda não contém o link, anexa o link sozinho numa linha (preview clicável no
 * WhatsApp). Conservador e idempotente: sem cartão / sem maps_url / link já presente →
 * devolve o texto sem tocar (nunca inventa endereço).
 */
export function ensurePickupMap(text: string, card: PickupCard | null): string {
  if (!card?.maps_url) return text;
  if (text.includes(card.maps_url)) return text;
  return `${text.trimEnd()}\n${card.maps_url}`;
}
