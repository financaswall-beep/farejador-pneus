# Handoff — Retiradas unificadas Matriz + parceiro

Data: 2026-08-23
Estado: fluxo de banco e painel web incorporado à `main`; migration 0204 aplicada
e verificada no banco novo de São Paulo. Incremento de Retiradas dentro do
`/operacao` implementado localmente nesta sessão, ainda sem commit, push ou deploy.

## Decisão de arquitetura

O Farejador continua sendo **um sistema só**: um repositório, um processo, um
deploy e um banco. O domínio de Retiradas tem uma só regra de servidor e agora
possui duas apresentações intencionais: painel web e operação móvel.

O que permanece separado de propósito é a fronteira de segurança:

- Matriz: sessão `ms_`, pool administrativo e ações de escrita owner-only;
- parceiro: sessão `ps_`, `PARTNER_DATABASE_URL`, `withPartnerContext` e RLS;
- cada parceiro enxerga somente a própria unidade.

Na Matriz, a leitura da fila também é owner-only. O botão antigo de Vendas não
conclui mais o pedido: ele apenas abre a tela Retiradas, impedindo um caminho
paralelo que ignorasse a conferência de serviços e pagamento.

Unificar a aparência não significa misturar estoque, caixa ou permissões.

## Fluxo implementado

1. Pedido do bot entra aguardando cliente. Estoque segue apenas reservado.
2. “Cliente chegou” grava a etapa operacional; não baixa estoque e não lança caixa.
3. O atendente pode incluir montagem, troca de bico e balanceamento.
4. Cada serviço é marcado como cortesia (R$ 0,00) ou cobrado (valor em centavos).
5. “Iniciar instalação” grava a etapa; ainda não realiza a venda.
6. “Confirmar retirada e pagamento” executa, na mesma transação:
   - materialização idempotente dos serviços como itens do pedido;
   - atualização do total cobrado;
   - consumo da reserva e baixa física dos pneus;
   - realização da venda e atribuição ao operador;
   - lançamento do recebimento/caixa;
   - cálculo causal de comissão e resultado;
   - auditoria do atendimento.
7. Qualquer erro desfaz tudo. Cancelar libera a reserva sem entrada no caixa.

## Contratos preservados

- serviço nunca altera estoque;
- cortesia tem receita zero e custo direto conhecido zero;
- serviço cobrado entra em venda, caixa, resultado e comissão;
- ranking de pneus filtra `item_type='pneu'`, portanto montagem não vira “pneu vendido”;
- o resumo de Vendas da Matriz também separa `pneusCount` de serviços, inclusive
  nas medidas mais vendidas;
- duplo clique não duplica serviço por causa da chave parcial
  `(environment, order_id, pickup_service_code)`;
- cancelamento bloqueia novo clique enquanto a primeira transação está em curso;
- a forma de pagamento é obrigatória na confirmação final;
- clientes anteriores da API continuam podendo concluir uma retirada sem enviar serviços;
- o servidor continua sendo a fonte da verdade; o navegador só mostra a prévia.

## Banco — migration 0204

Arquivo: `db/migrations/0204_pickup_service_workflow.sql`.

Adições:

- etapas e rascunho de serviços em `commerce.orders` e `commerce.partner_orders`;
- `pickup_service_code` nos dois tipos de item de pedido;
- índices de idempotência e fila;
- três produtos internos de serviço para a Matriz, em `prod` e `test`;
- smoke estrutural dentro da própria migration.

O boot agora recusa iniciar se o contrato mínimo da 0204 estiver ausente. A
migration foi executada em 23/08/2026 no projeto `beisgivepyfhgcujsqan`, usando
o session pooler de São Paulo e sem usar a conexão antiga `.env.pooler`.

Antes do commit foi executado um dry-run integral com rollback. Depois do
commit, o smoke do banco confirmou 6 colunas de fluxo, 2 colunas de
idempotência, 4 constraints, 4 índices e 6 produtos internos de serviço.
Nenhuma migration adicional foi criada para o incremento móvel: ele reutiliza
integralmente o contrato da 0204. A etapa restante desse incremento é:
**commit/push → deploy feito pelo dono → smoke autenticado**.

## Interfaces

- `/admin/painel`: painel web moderno, com fila + detalhe;
- `/operacao`: o aplicativo móvel/frente rápida já existente, agora incrementado
  com a aba Retiradas, cards e folha inferior de atendimento;
- o casco, login, cabeçalho, menu inferior e módulos que já funcionavam no
  `/operacao` foram preservados; não houve reescrita do aplicativo;
- Matriz e parceiro usam a mesma apresentação móvel, mas a rota é escolhida pelo
  local autenticado: Matriz usa `/api/caixa/retiradas`; parceiro usa
  `/parceiro/:slug/api/retiradas`;
- na Matriz, Retiradas do `/operacao` é owner-only; no parceiro exige a permissão
  explícita `retiradas`;
- busca e filtros por etapa;
- KPIs de aguardando, chegada, instalação e conclusão;
- identidade visual verde; vermelho somente para cancelamento;
- foto aprovada na conversa continua como apoio opcional;
- WhatsApp permanece disponível quando há telefone.

### Fluxo móvel acrescentado nesta sessão

- aguardando → “Cliente chegou”: muda somente a etapa;
- chegada → pagamento e serviços opcionais;
- serviço pode ser cortesia ou cobrado, com total recalculado durante a digitação;
- instalação é uma etapa opcional antes da conclusão;
- conclusão usa a mesma transação auditada da Matriz ou do parceiro;
- cancelamento da Matriz é estreito: só aceita pedido de retirada aberto, com
  reserva auditada e sem vínculo de atacado. Uma venda comum não pode ser
  cancelada por essa rota;
- a folha de atendimento termina acima do menu inferior existente, sem esconder
  ações nem alterar a navegação do aplicativo.

## Provas executadas

- `npm run build`: aprovado;
- `npm run check:migrations`: 205 migrations, aprovado;
- `npm test`: 274 arquivos, 1.353 testes, aprovado;
- `npm run prova-painel`: aprovado;
- paridade do painel: 1.237 propriedades; baseline regravado conscientemente
  para os novos estados e a classificação pneu/serviço;
- paridade de rotas: 260 rotas, incluindo os endpoints de Retiradas da Matriz;
- fiscal de tamanho: aprovado; retirada do parceiro foi extraída para
  `src/parceiro/pickup-queries.ts`; os três módulos novos do `/operacao` ficam
  abaixo de 300 linhas e `caixa-core.js` permanece no teto de 300 linhas;
- prova de navegador local: aba autorizada, 3 cards, KPIs 1/2/1/0, zero overflow
  horizontal, folha de atendimento, formas de pagamento, inclusão de serviço e
  cálculo R$ 89,00 + R$ 20,00 = R$ 109,00 aprovados.

## Prova PostgreSQL

`tests/integration/pickup-service-workflow.integration.test.ts` agora cobre
parceiro, Matriz e a proteção que impede cancelar uma venda comum pela rota de
Retiradas. A nova execução local não chegou aos cenários porque
o Docker Desktop deixou de responder: `docker version` também ficou pendurado,
e o hook expirou durante a criação do PostgreSQL 17. Isso é **pendência**, não
aprovação nem reprovação do fluxo local.

O GitHub CI é o portão PostgreSQL desta publicação. No primeiro ciclo, o cenário
do parceiro passou integralmente; o cenário da Matriz foi bloqueado antes do
fluxo porque a fixture usava a origem inexistente `agent_v2`. A restrição
`orders_source_check` funcionou corretamente, e a fixture foi corrigida para a
origem real `chatwoot_com_bot`. O PR somente pode ser incorporado depois do novo
ciclo verde.

O segundo ciclo avançou até o código de produção e encontrou uma inferência
ambígua do mesmo parâmetro como `text` e `env_t` na materialização de serviços
da Matriz. A consulta passou a tipar o ambiente explicitamente como
`public.env_t`. Essa foi uma correção real do caminho Matriz, e o merge continua
condicionado a um ciclo integralmente verde.

No primeiro ciclo do incremento móvel, os cenários transacionais de parceiro e
Matriz passaram. O cenário novo de proteção de cancelamento não chegou à função:
a fixture criou uma entrega sem endereço e o CHECK histórico de `commerce.orders`
barrou corretamente a linha. A fixture passou a informar endereço de entrega;
isso corrige somente o teste, sem afrouxar regra do banco. O novo merge continua
condicionado à repetição integralmente verde do CI.

Para repetir a mesma prova localmente depois de recuperar o Docker Desktop:

```text
npm run test:integration -- tests/integration/pickup-service-workflow.integration.test.ts
```

A 0204 já foi aplicada no banco correto. Para o incremento móvel, resta publicar
o código, obter o CI PostgreSQL verde e fazer smoke real no `/operacao` com uma
retirada da Matriz e outra de unidade canário.
