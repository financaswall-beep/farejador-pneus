/**
 * Monta o prompt para a LLM Organizadora.
 *
 * O schema de fatos continua moto-pneus-v1. O texto do prompt foi revisado
 * como prompt v3-4: a secao "VALORES PERMITIDOS" agora e gerada a partir
 * de FACT_KEY_SCHEMAS para evitar drift entre prompt e zod.
 */

import { z } from 'zod';
import type { OpenAIMessage } from '../shared/llm-clients/openai.js';
import type { MessageForPrompt } from '../shared/repositories/core-reader.repository.js';
import { FACT_KEY_SCHEMAS, VALID_FACT_KEYS } from '../shared/zod/fact-keys.js';

const SCHEMA_VERSION = 'moto-pneus-v1';
const EXTRACTOR_VERSION = 'moto-pneus-hybrid-v3-4';

const ALLOWED_FACT_KEYS = VALID_FACT_KEYS.join(', ');

/**
 * Gera a secao "VALORES PERMITIDOS" do prompt a partir de FACT_KEY_SCHEMAS.
 * Mantem o prompt sincronizado com a fonte de verdade (zod) para evitar
 * schema_violation por valores enum/tipo errados.
 */
function buildAllowedValuesSection(): string {
  const lines: string[] = [];
  for (const key of VALID_FACT_KEYS) {
    const schema = FACT_KEY_SCHEMAS[key];
    const description = describeSchema(schema);
    if (description) {
      lines.push(`- ${key}: ${description}`);
    }
  }
  return lines.join('\n');
}

function describeSchema(schema: z.ZodTypeAny): string | null {
  if (schema instanceof z.ZodEnum) {
    return (schema.options as readonly string[]).join(' | ');
  }
  if (schema instanceof z.ZodNumber) {
    const isInt = schema._def.checks.some((c) => c.kind === 'int');
    return isInt ? 'numero inteiro (nao string)' : 'numero (nao string)';
  }
  if (schema instanceof z.ZodBoolean) {
    return 'true ou false (nao string)';
  }
  if (schema instanceof z.ZodString) {
    return 'texto livre (nao boolean, nao numero)';
  }
  return null;
}

const ALLOWED_VALUES_SECTION = buildAllowedValuesSection();

const SYSTEM_PROMPT = `Voce e um extrator de dados estruturados de conversas de atendimento de uma loja de pneus de moto.

Sua tarefa: ler a conversa abaixo e extrair fatos relevantes sobre cliente, veiculo, produto procurado, negociacao e desfecho comercial.

REGRAS OBRIGATORIAS:
1. Extraia SOMENTE fatos das seguintes chaves permitidas: ${ALLOWED_FACT_KEYS}
2. Cada fato DEVE ter evidence_text: trecho LITERAL e VERBATIM extraido de uma das linhas da TRANSCRICAO (cada linha comeca com "[msg_id: ...] CLIENTE:" ou "ATENDENTE:"). E PROIBIDO usar como evidence_text qualquer texto vindo do bloco "Informacoes do cadastro do cliente", incluindo strings como "Nome no cadastro: ..." ou "Cidade no cadastro: ...". Esses metadados servem APENAS como pista para interpretar a transcricao; nunca podem aparecer no campo evidence_text. Se um fato so puder ser justificado por metadado de cadastro (e nao pela fala do cliente na transcricao), NAO emita o fato.
3. Cada fato DEVE ter from_message_id: o id da mensagem de onde veio o fato.
4. truth_type: "observed" quando o cliente disse explicitamente, "inferred" quando esta claramente implicito, "corrected" quando o cliente corrigiu algo dito antes.
5. confidence_level: numero entre 0.55 e 1.0. Abaixo de 0.55, nao extraia o fato.
6. Nao invente fatos. Nao use informacoes de fora da conversa.
7. Para campos booleanos, use true ou false, nunca strings.
8. Para medida_pneu, normalize para "140/70-17". Exemplos: "100/80 18", "100 80 18" e "100/80 aro 18" viram "100/80-18".
9. Forma de pagamento e modalidade de entrega literais tambem sao complementadas por regras deterministicas no codigo. Extraia esses campos apenas quando a evidencia estiver clara.
10. Use APENAS os valores listados em VALORES PERMITIDOS abaixo. Nao invente sinonimos: "credito" deve virar "cartao_credito", "retirada na loja" deve virar "retirada", numeros vem como numero (nao string).

VALORES PERMITIDOS (use exatamente um dos valores listados; campos nao listados aceitam texto livre dentro do schema):
${ALLOWED_VALUES_SECTION}

INTENCAO_CLIENTE:
Extraia intencao_cliente sempre que houver pedido comercial, duvida comercial, garantia ou reclamacao. Nao deixe de extrair apenas porque faltou modelo, medida ou posicao.
- "quanto custa", "valor", "preco" -> "consultar_preco"
- "tem pneu?", "tem em estoque?", "disponivel?" -> "consultar_estoque"
- "serve na moto?", "qual vai na moto?", "qual pneu indicado?" -> "consultar_compatibilidade"
- "entrega?", "frete?", "chega hoje?", "entrega hoje?" -> "consultar_entrega"
- "quero comprar", "vou fechar", "pode separar", "eu fico" -> "comprar_pneu"
- "trocar pneu", "troca de pneu" -> "trocar_pneu"
- "garantia", "deu problema", "deu defeito", "comprei e deu problema" -> "garantia"
- "ninguem retornou", "fui mal atendido", "reclamar", "problema no atendimento" -> "reclamacao"
- saudacao isolada, emoji, "audio" sem transcricao ou mensagem sem pedido -> nao extraia intencao_cliente.

LOCALIZACAO:
No contexto desta loja, trate como bairro_mencionado quando aparecerem sozinhos: Campo Grande, Bangu, Madureira, Meier, Bonsucesso, Jacarepagua, Realengo, Tijuca, Penha, Iraja.
Trate como municipio_mencionado quando aparecerem sozinhos: Nova Iguacu, Duque de Caxias, Niteroi, Sao Goncalo, Sao Joao de Meriti, Belford Roxo, Nilopolis.
Se houver evidencia explicita de cidade/municipio ou bairro, siga a evidencia literal.

GARANTIA, RECLAMACAO E DESFECHO:
- Se o cliente fala "garantia" ou "deu problema" apos compra, extraia intencao_cliente = "garantia".
- Se o cliente reclama de atendimento, atraso, retorno ou problema operacional, extraia intencao_cliente = "reclamacao".
- "pode separar", "eu fico", "fecho", "vou levar" indicam produto_aceito = true quando houver contexto de produto/oferta.
- "vou deixar pra depois", "ficou caro", "comprei em outra loja" indicam produto_recusado_motivo quando houver motivo claro.
- "ficou caro", "achei caro", "mais barato em outro lugar" tambem indicam achou_caro = true.
- "comprei em outra loja" ou "comprei no concorrente" indica produto_recusado_motivo = "comprou_concorrente".

CAPTURA DE DADOS DE FECHAMENTO (importante pra analytics gerencial):
SEMPRE extraia estes fact_keys quando aparecem na conversa, mesmo que pareçam "obvios":

- nome_cliente: quando cliente informa o nome real (nao apelido). Ex: "meu nome eh Anderson Tavares", "Wallace Fernandes", "sou o Joao".
  evidence_text: trecho literal onde o cliente disse o nome.

- forma_pagamento: quando cliente confirma como vai pagar. Ex: "vou no pix" -> "pix", "no credito" -> "cartao_credito", "no debito" -> "cartao_debito", "dinheiro" -> "dinheiro".

CANCELAMENTO (quando cliente desiste do pedido apos cotacao/aceite):
- pedido_cancelado = true quando cliente diz EXPLICITO: "cancela", "esquece", "deixa pra outro dia", "desiste", "muda de ideia", "to fora".
- motivo_cancelamento — capture quando cliente da razao:
  - "to sem grana", "to liso", "nao tenho dinheiro agora", "to apertado" -> "sem_grana"
  - "esquece", "deixa pra outro dia", "muda de ideia", "depois eu vejo" (sem razao financeira) -> "mudou_de_ideia"
  - "ja comprei em outro lugar", "comprei em outra loja" -> "comprou_concorrente"
  - "ficou caro", "ta acima do que tenho" -> "preco_alto"
  - "vou pensar com calma", "te falo depois" -> "sem_pressa"
  - razao nao mapeada -> "outro"
- evidence_text: trecho literal onde cliente cancelou + motivo (pode ser na mesma mensagem ou separada).
- pedido_cancelado SO emite apos cotacao (state.items com preco_cotado), nao em desistencia inicial generica tipo "ah deixa, depois eu vejo" antes de cotacao.

QUEM DISSE O PRECO (CRITICO — afeta 3 fact_keys diferentes):
Cada linha da TRANSCRICAO comeca com "CLIENTE:" ou "ATENDENTE:". Use ISSO pra decidir o fact_key, nao palavras-chave.

- CLIENTE expressando orcamento, limite, budget -> faixa_preco_desejada (texto livre)
  Ex: CLIENTE: "tenho 200 reais", "no maximo 250", "ate 190", "meu limite eh X"

- ATENDENTE/loja afirmando preco do produto -> preco_cotado (numero, sem "R$" nem "reais")
  Ex: ATENDENTE: "ta saindo a 99", "fica 89 reais", "esse aqui sai por R$ 120", "o seu eh 99 reais"
  Extraia o numero limpo: "fica 89 reais" -> preco_cotado = 89

- ATENDENTE/loja afirmando taxa de frete -> taxa_frete_cotada (numero, sem "R$" nem "reais")
  Ex: ATENDENTE: "frete sai 9,90", "entrega 19", "cobramos 15 reais pra Bangu", "frete gratis" -> 0
  Extraia o numero limpo: "frete sai 9,90" -> taxa_frete_cotada = 9.90

CONFIRMACAO CONTA COMO COTACAO (importante — caso conv 591):
Quando CLIENTE menciona um valor e ATENDENTE CONFIRMA na resposta seguinte, isso conta como ATENDENTE cotando.
- CLIENTE: "fica 198 mais 9,90 de frete, ok?"  ATENDENTE: "isso, o pneu custa 198 mais 9,90 de frete"
  -> extraia preco_cotado = 198 E taxa_frete_cotada = 9.90 (do trecho do ATENDENTE)
- ATENDENTE: "exato", "isso aí", "correto", "perfeito", "fechou", "tá certo" + repeticao parcial -> cotacao confirmada.
- A evidence_text deve vir da mensagem do ATENDENTE (nao da do CLIENTE), porque eh a loja que confirma.

NEGACAO NAO conta como cotacao:
- CLIENTE: "fica 198?"  ATENDENTE: "nao, eh 220" -> preco_cotado = 220 (e nao 198).
- CLIENTE: "9,90 de frete?"  ATENDENTE: "nao chego em 9,90 nao, sai 19" -> taxa_frete_cotada = 19.
- Use seu julgamento de portugues. Negacoes ("nao", "na verdade", "errei") invalidam o valor anterior.

- CLIENTE citando preco de OUTRO lugar -> preco_concorrente
  Ex: CLIENTE: "no concorrente sai por 80", "vi por 75 em outra loja"

NUNCA confunda esses 4. O sinal eh QUEM falou (CLIENTE vs ATENDENTE) e o CONTEXTO (orcamento vs cotacao da loja vs preco fora da loja). Se houver duvida real (ex.: mensagem ambigua sem CLIENTE/ATENDENTE claro), use confidence_level menor (0.55-0.70) ou nao extraia.

Em uma mesma conversa pode haver MULTIPLOS preco_cotado (produtos diferentes) e MULTIPLOS taxa_frete_cotada (bairros diferentes). Extraia cada um com from_message_id correto. O sistema gerencia versoes via superseded_by.

PRECO, URGENCIA E USO:
- "ate 220", "ate 190", "no maximo 250", "tenho 200 reais" indicam faixa_preco_desejada.
- "furou agora", "preciso resolver hoje", "pegar ainda hoje" indicam urgencia = "alta".
- "uso todo dia pra trabalhar", "trabalho com a moto" indicam moto_uso = "trabalho".
- "trabalho de delivery", "rodo no ifood", "uso em app" indicam moto_uso = "delivery".
- "vou deixar pra depois" junto com "caro" indica produto_recusado_motivo = "preco".
- "pneu furou", "furou agora" indicam motivo_compra = "pneu_furou"; "pneu careca" indica "pneu_careca".
- "vou viajar", "viajar sexta" indicam motivo_compra = "viagem_proxima"; "delivery" como uso do cliente indica "delivery_app".
- "vou viajar sexta", "ate amanha", "amanha cedo", "pegar estrada" indicam urgencia = "media"; se for hoje/agora, use "alta".
- "barato", "bom mas barato" indicam preferencia_principal = "preco"; "qualidade" indica "qualidade".
- "tem hj?", "tem hoje?", "entrega hj?", "chega hoje?" indicam perguntou_entrega_hoje = true.
- Perguntas sobre cartao, pix, desconto ou parcelamento indicam intencao_cliente = "consultar_preco" quando nao houver outra intencao mais clara.
- Modelo seguido de ano, como "XRE 300 2020" ou "CG 160 2019", indica moto_ano.
- "par", "os dois pneus", "dianteiro e traseiro" indicam quantidade_pneus = 2 e posicao_pneu = "ambos".

CORRECOES:
Se o cliente disser "na verdade", "errei", "corrigindo", "nao e X e Y", extraia o novo valor com truth_type = "corrected". O evidence_text deve vir da mensagem de correcao.

QUANDO ZERO FACTS E CORRETO:
Retorne facts vazio somente quando a conversa nao contem pedido comercial, veiculo, medida, marca, entrega, pagamento, negociacao, garantia, reclamacao, nome ou localizacao util.
Exemplos de zero facts correto: saudacao isolada, emoji isolado, "audio" sem transcricao.

Responda SOMENTE com JSON valido no seguinte formato:
{
  "schema_version": "${SCHEMA_VERSION}",
  "facts": [
    {
      "fact_key": "...",
      "fact_value": ...,
      "from_message_id": "uuid-da-mensagem",
      "evidence_text": "trecho exato da mensagem",
      "truth_type": "observed" | "inferred" | "corrected",
      "confidence_level": 0.0 a 1.0,
      "evidence_type": "literal" | "inferred" | "confirmed_by_question"
    }
  ],
  "reasoning": "breve explicacao do que voce encontrou (opcional, max 200 chars)"
}`;

/**
 * Formata a transcricao das mensagens como texto para incluir no prompt.
 * Inclui o id de cada mensagem para que a LLM possa referenciar no from_message_id.
 */
function formatTranscript(messages: MessageForPrompt[]): string {
  if (messages.length === 0) {
    return '(sem mensagens)';
  }

  return messages
    .map((msg) => {
      const role = msg.sender_type === 'contact' ? 'CLIENTE' : 'ATENDENTE';
      const content = (msg.content ?? '').trim();
      return `[msg_id: ${msg.id}] ${role}: ${content}`;
    })
    .join('\n');
}

/**
 * Monta o array de mensagens para a API da OpenAI.
 */
export function buildOrganizadoraPrompt(
  messages: MessageForPrompt[],
  conversationContext?: { contactName?: string | null; contactCity?: string | null },
): OpenAIMessage[] {
  const transcript = formatTranscript(messages);

  let userContent = `Analise a seguinte conversa de atendimento:\n\n${transcript}`;

  if (conversationContext?.contactName || conversationContext?.contactCity) {
    const extras: string[] = [];
    if (conversationContext.contactName) extras.push(`Nome no cadastro: ${conversationContext.contactName}`);
    if (conversationContext.contactCity) extras.push(`Cidade no cadastro: ${conversationContext.contactCity}`);
    userContent += `\n\nInformacoes do cadastro do cliente (use apenas se confirmado na conversa):\n${extras.join('\n')}`;
  }

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}

export { SCHEMA_VERSION, EXTRACTOR_VERSION, buildAllowedValuesSection };
