# Controle humano por conversa — Matriz

## Comportamento

- Resposta pública de usuário humano no Chatwoot pausa somente aquela conversa.
- Nota privada, atividade e mensagem do próprio bot não acionam a pausa.
- A identificação do bot usa o ID confirmado pela API ou correlação com a outbox da mesma conversa/ambiente; não usa nome, texto nem o usuário dono do token.
- “Assumir atendimento” e “Devolver ao bot” são controles internos, disponíveis na fila do Bot e no detalhe do lead. Não criam mensagens públicas nem notas no Chatwoot.
- O estado fica em `ops.conversation_bot_control`, com histórico append-only em `ops.conversation_bot_control_events`.
- Mensagem nova do cliente não retoma automaticamente. Retomada exige ação explícita e versão atual do controle.
- Retomada aguarda nova mensagem do cliente; gatilhos/rascunhos anteriores são descartados. Mover ou arquivar cards não altera este estado.
- As flags globais continuam sendo respeitadas e não são alteradas pela implementação.

## Concorrência e limites

A geração verifica o controle antes e depois do LLM, antes de ferramentas e antes de enfileirar a resposta. A outbox verifica novamente antes do HTTP, inclusive pesquisas e fotos. Falha na leitura do controle impede envio.

O sender mantém uma transação com `pg_advisory_xact_lock` até persistir o resultado do envio. A troca de controle usa a mesma chave, isolada por ambiente e conversa. Não são usados locks de sessão: o desenho é compatível com pooler Supabase em modo transaction. O HTTP tem timeout de 10 segundos e uma tentativa por passagem da outbox.

A pausa automática depende da chegada/processamento do webhook humano. Uma mensagem já aceita pelo Chatwoot, ou um envio já iniciado antes da intervenção, não pode ser recolhida. Para assumir antes de escrever, usar o botão interno e aguardar a confirmação. Ferramentas que já terminaram não são desfeitas.

## Foto de contatos

O avatar pode ser lido da referência já presente em `raw.raw_events`, sem modificar o evento nem criar cópia da foto. A seleção exige ambiente, conversa e contato correspondentes; uma conta válida também deve coincidir. Quando a conta normalizada é zero, somente uma referência comprovada no webhook pode supri-la — nunca a conta global presumida.

Eventos de conversa sem conta válida deixam de substituir uma conta já conhecida por zero. Mensagens podem completar uma conta ainda desconhecida. Nenhum backfill de produção foi executado.

## Publicação e validação

Em 2026-09-05, após autorização explícita do responsável, a migration 0216 foi aplicada no banco de produção Farejador Matriz (sa-east-1) pelo executor versionado. Pós-verificação confirmou versão 216, 217 entradas no ledger e checksum `10c223869c6283a300b89348caae3cb062d1c55aabf39c00282890bdc34618b4`. As flags do bot não foram alteradas. Para esta publicação, a etapa de banco já está concluída; não é necessário colar SQL manualmente.

No deploy pelo Coolify, selecionar o commit publicado deste pacote e preservar `AGENT_V2_WORKER_ENABLED=false` e `BOT_OUTBOX=false`. Confirmar `/healthz` com HTTP 200 e o commit esperado depois da publicação. O deploy da aplicação fica a cargo do responsável; aplicar a migration não publica o código nem ativa o bot.

Ordem para reproduzir a atualização em outro ambiente autorizado:

1. Manter o bot desligado durante a atualização; não reativar automaticamente.
2. Executar `tests/integration/conversation-bot-control.integration.test.ts` no PostgreSQL isolado, pelo `vitest.integration.config.ts`. O helper cria container de teste e não usa o banco de produção.
3. Aplicar `0216_conversation_bot_control.sql` pelo executor versionado `scripts/apply-migration-file.cjs`, com autorização específica para produção. Ele registra checksum e ledger. Não aplicar só o SQL sem registrar o ledger.
4. Publicar o código. O boot agora exige a migration 0216 e seu checksum; sem ela, recusa iniciar.
5. Em conversa de teste autorizada no Chatwoot de produção: verificar pausa por resposta humana, silêncio para o cliente, isolamento de outra conversa e retomada somente após nova mensagem. Não enviar testes a clientes reais.

A migration estabelece uma data inicial para conversas existentes, evitando reinterpretar mensagens humanas antigas como novas intervenções. Na ativação, gatilhos anteriores a essa data não são reenviados. Reaplicar a migration não sobrescreve estados existentes.

Validação local em 2026-09-05: 1.565 testes unitários (312 arquivos), compilação e 40 testes de integração em PostgreSQL 17 isolado no Docker (9 arquivos) passaram. Destes, 14 cobrem o controle humano, incluindo retomada, descarte dos quatro tipos de saída, concorrência, reprocessamento, isolamento de ambiente e reaplicação da migration. Também passaram as regressões de outbox, Kanban, marketing, métricas, ordem de deploy, idempotência, gatilhos antigos e imutabilidade de raw.

O teste com banco real identificou e permitiu corrigir perda de precisão de timestamps: o controle agora preserva os microssegundos do PostgreSQL, evitando registrar duas vezes a mesma intervenção e comparando corretamente o limite da retomada.

A referência real de avatar foi consultada somente por leitura, e a prévia de navegador usou clientes fictícios. A única alteração em produção foi a migration autorizada, descrita acima. Nenhum envio de teste ou deploy da aplicação foi executado. Não substituir testes isolados por dry-run de mutações no banco de produção.

A prova geral do painel passou integralmente. A pendência anterior de tamanho foi resolvida extraindo a função de leitura do token HTTP para `src/parceiro/request-token.ts`, sem alterar seu comportamento, com sete casos de regressão. O arquivo de rotas ficou com 1.671 linhas, abaixo do teto congelado de 1.678; o limite não foi ampliado.

A primeira execução no GitHub identificou uma dependência de preparação: um teste do painel lê o CSS compilado, que não é versionado. `npm test` agora executa `build:css` no `pretest`, garantindo os mesmos artefatos em checkout limpo e no desenvolvimento local, sem remover ou enfraquecer testes.
