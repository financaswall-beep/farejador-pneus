# Auditoria ponta a ponta da Logística — Matriz, entregador e parceiro

**Data:** 21/08/2026
**Código auditado:** `abbcab556cf2a6b32b9a4875fc0d94e9e2479d52`
**Banco:** produção auditada, migration aplicada e PostgreSQL 17 descartável
**Situação:** auditoria concluída; 12 correções implementadas e aprovadas; migration `0191`
aplicada materialmente após backup validado; código ainda aguardando publicação/deploy

## 1. Veredito executivo

O núcleo da Logística é sólido: entrega da Matriz consome a reserva, atualiza o pedido e
publica receita/CMV de forma atômica; falha reportada pelo entregador não devolve estoque
antes da decisão do escritório; comprovantes são reencodados, revisados por humano e só
então viram despesa; rotas não fecham com paradas pendentes; RLS e posse da rota impediram
acesso cruzado nos caminhos auditados.

Os cálculos da rota também fecharam em centavos. Entretanto, a seção **ainda não deve ser
declarada encerrada para produção**. Foram confirmados quatro bloqueadores de integração e
oito problemas relevantes de operação/escala. Nenhum deles corrompe os dados atualmente
existentes, mas alguns produzem erro financeiro ou de estoque quando o caso de borda ocorre.

**Veredito atual da Logística: NÃO APROVADA COMO SEÇÃO FINALIZADA até corrigir e repetir as
provas dos bloqueadores.**

## 2. Relações percorridas

| Origem | Destino | Relação conferida |
|---|---|---|
| Vendas da Matriz | Logística | pedido `delivery` nasce pendente, com endereço, cliente, itens, valor e pagamento |
| Logística da Matriz | Estoque | reserva permanece indisponível enquanto o pneu está na rota; entrega consome; falha confirmada devolve |
| Logística da Matriz | Financeiro | entrega cria receita, CMV e baixa de caixa/recebível; comprovante aprovado cria despesa |
| Logística da Matriz | Colaboradores | rota e entrega alimentam desempenho, comissão e folha pelo identificador do colaborador |
| Logística da Matriz | Clientes/Chatwoot | pedido pode vir de `core.contacts` ou de `commerce.customers` no balcão |
| App do entregador | Matriz | fila, abertura da própria rota, andamento, falha reportada, foto, comprovante e fechamento |
| Venda do parceiro | Entregas do parceiro | pedido local reserva estoque e só realiza venda/caixa quando entregue |
| Entrega do parceiro | Estoque do parceiro | entrega consome a reserva; cancelamento libera a reserva |
| Entrega do parceiro | Financeiro do parceiro | recebível muda para recebido pelo valor exato e pela forma de pagamento real |
| Entrega do parceiro | Funcionários | permissão `entregas`, sessão, operador finalizador e comissão |
| Compras | Estoque/Logística | Compras forma saldo e custo médio; a entrega usa o custo congelado da venda, sem reprecificar o passado |

## 3. O que está correto

### 3.1 Matriz e app do entregador

- Toda escrita do entregador exige a rota aberta do colaborador autenticado.
- Um entregador não consegue alterar rota, pedido, foto ou comprovante de outro.
- O banco impede mais de uma rota aberta para o mesmo `courier_collaborator_id`.
- As transições do app são restritas: pendente → saiu → entregue; retorno para pendente só
  antes da entrega.
- “Não entregue” no app apenas reporta. Estoque e dinheiro permanecem protegidos até a
  decisão administrativa.
- Fechar a rota bloqueia `pending` e `dispatched`, trava a rota e revalida depois de espera
  concorrente.
- `km_start`, `km_end` e combustível não aceitam negativos; `km_end < km_start` é recusado
  pelo banco.
- Entrega, consumo da reserva, receita, CMV e pagamento ficam na mesma transação.

### 3.2 Comprovantes e despesas

- Arquivo é limitado, validado pelos bytes reais, reencodado e perde EXIF.
- Metadado e blob ficam separados; lista de rotas não arrasta a imagem inteira.
- Hash evita reaproveitar o mesmo comprovante em rotas diferentes.
- IA apenas sugere. Somente aprovação humana do proprietário cria despesa.
- Valor, competência, data do documento, data de pagamento, duplicidade e remoção da despesa
  possuem proteções adicionais no banco.
- A divergência entre combustível anotado e comprovante oficial fica visível e exige decisão
  explícita do proprietário.

### 3.3 Matemática

A sonda descartável criou uma rota com dois itens e comprovou diretamente a consulta real:

| Componente | Valor comprovado |
|---|---:|
| Faturamento total | R$ 280,02 |
| Receita dos pneus | R$ 240,02 |
| Frete implícito | R$ 40,00 |
| Custo congelado dos pneus | R$ 150,00 |
| Lucro dos pneus | R$ 90,02 |
| Margem antes das despesas da rota | R$ 130,02 |

As fórmulas efetivas são:

- pneus = soma de `quantidade × preço unitário − desconto da linha`;
- frete = `máximo(total do pedido − valor dos pneus, zero)`;
- CMV = soma de `quantidade × custo congelado`;
- resultado da rota = `frete + lucro dos pneus − despesas vinculadas`.

Na produção atual houve zero frete implícito negativo, zero divergência entre receita/CMV e
ledger e zero fato financeiro positivo ausente.

## 4. Bloqueadores confirmados

### L-B01 — repetir “entregue” no parceiro muda o passado financeiro

`updatePartnerDeliveryStatus` aceita repetir `delivered`. No conflito do recebível, a rotina
executa novamente `received_at = now()` e aceita trocar forma de pagamento. A atualização do
pedido também aceita trocar o nome do entregador.

A prova descartável entregou uma vez por Pix, fixou uma data antiga e repetiu a chamada por
Dinheiro. O mesmo recebível mudou para a hora atual, a forma passou a Dinheiro e o entregador
foi substituído. Não duplica a linha, mas pode mover o caixa de um dia/mês para outro e
reescrever a história.

**Correção necessária:** replay de estado terminal deve devolver exatamente o primeiro
resultado sem atualizar `received_at`, pagamento, entregador ou auditoria.

### L-B02 — entrega da Matriz usa a data do pedido na competência do ledger

A receita e o CMV só são publicados quando a entrega é confirmada, porém recebem
`created_at` como competência. A sonda criou pedido em 31/07 e entrega em 01/08; o ledger
gravou competência **31/07**.

Isso contradiz o fato comercial: antes da entrega, o pedido ainda pode falhar. Em virada de
mês, Vendas/Logística dizem agosto, enquanto o Financeiro reconhece julho.

**Correção necessária:** para `fulfillment_mode='delivery'`, receita e CMV devem usar
`delivered_at`; retirada imediata continua usando o fato próprio já definido.

### L-B03 — rota aberta pela Matriz não pertence ao entregador informado

O painel administrativo pede somente um nome livre. `openMatrizTrip` grava
`courier_collaborator_id = NULL`. O app do entregador procura exclusivamente pelo ID do
colaborador autenticado.

A prova abriu uma rota para “Marcos”: ela não apareceu como rota de Marcos e o pedido também
sumiu da fila dele porque já tinha `trip_id`. A mesma rota não alimenta desempenho, comissão
ou folha do colaborador; o fechamento da folha possui uma proteção que detecta justamente
eventos sem responsável.

**Correção necessária:** o painel deve selecionar um colaborador ativo de Entregas e gravar
o ID. Nome livre pode existir apenas como observação excepcional, nunca como identidade.

### L-B04 — falha do parceiro libera estoque antes do retorno físico

No app da Matriz, o entregador reporta a falha e o escritório decide. No parceiro, qualquer
funcionário com a tela Entregas pode marcar `failed`; a mesma chamada cancela o pedido,
cancela o recebível e libera a reserva imediatamente.

O pneu pode ainda estar no veículo. Nesse intervalo o sistema o mostra disponível para nova
venda sem ele ter voltado à loja. A API também aceitou mudar uma entrega já cancelada para
`pending`, deixando `status='cancelled'` e `delivery_status='pending'`.

**Correção necessária:** separar “falha reportada” de “retorno físico confirmado”. O primeiro
estado não mexe no estoque; a confirmação na loja cancela/libera a reserva. Estados terminais
não podem voltar por esse endpoint.

## 5. Problemas relevantes

### L-P01 — painel administrativo mostra apenas a primeira rota aberta

O backend suporta uma rota por entregador, mas `logisticaRotaAtual()` e `rotaAberta()` sempre
usam `rotas_abertas[0]`. A tela esconde “Nova rota” enquanto qualquer rota está aberta e o
botão “Pôr na rota” usa a primeira. Com dois entregadores, uma rota fica invisível ou o pedido
pode ser ligado à rota errada.

### L-P02 — venda de balcão perde nome e telefone no app do entregador

A tela administrativa usa `COALESCE(core.contacts, commerce.customers)`. O card do entregador
consulta somente `core.contacts`. A prova com `customer_id` de balcão retornou nome e telefone
nulos.

### L-P03 — reentrega pode conservar o nome do entregador anterior

Recolocar limpa estado, motivo e rota, mas não limpa `delivery_courier`. Ao pendurar em outra
rota, a consulta usa `COALESCE` e mantém o nome antigo. A prova terminou com rota de João e
pedido exibindo Marcos.

### L-P04 — erro de comprovante vira 500 no app da Matriz

O upload administrativo traduz limite e duplicata. O upload do app do entregador trata apenas
`trip_not_found`. A interface já espera `receipt_exact_duplicate`, mas o backend devolve erro
interno. O `catch` de duplicata está, por engano, no fechamento da rota, operação que não faz
upload.

### L-P05 — teto de 50 comprovantes não é seguro sob concorrência

O código conta e depois insere sem travar a rota ou possuir constraint de teto. Com 49
comprovantes e dois uploads simultâneos, a sonda confirmou **51** registros. A deduplicação de
conteúdo continua segura; o problema é apenas o limite antiabuso.

### L-P06 — “Últimos 7 dias” olha para os próximos 7

Operação e Histórico reutilizam o mesmo filtro. Para `7dias`, a função compara hoje até D+6,
correto para agenda futura, mas a subaba Histórico chama a opção de “Últimos 7 dias”. Na
prática, ela mostra apenas concluídas de hoje.

### L-P07 — histórico e indicadores param nos 30 últimos pedidos

O servidor retorna `LIMIT 30` para finalizadas e o navegador calcula quantidade, sucesso e
tempo médio sobre esse recorte. Quando houver mais de 30 entregas no período, os indicadores
de 7/30 dias ficam matematicamente incompletos. Rotas fechadas também são limitadas às dez
últimas sem paginação.

### L-P08 — rota fechada com comprovante rejeitado pode ficar sem saída pela tela

O backend aceita anexar comprovante a rota fechada, mas a tela oferece upload apenas na rota
aberta. Se o combustível foi informado e o único comprovante foi rejeitado, não há botão para
anexar o correto nem corrigir o fechamento com trilha de auditoria.

Esse caso já aparece nos dados de teste: `ROTA-0074` está fechada, com R$ 58,00 anotados,
comprovante rejeitado e conciliação pendente.

## 6. Endurecimentos recomendados

- Exigir transições explícitas também na API administrativa da Matriz; hoje ela é mais aberta
  que o app do entregador.
- Vincular a atribuição do parceiro ao ID da pessoa/sessão, não ao nome digitado. Duas
  tentativas de “assumir” podem se sobrescrever e outro funcionário pode finalizar a entrega.
- Exigir forma de pagamento normalizada ao receber dinheiro; hoje a API do parceiro aceita
  texto livre ou nulo.
- Tornar confirmação de entrega e falha idempotentes para duplo clique e rede móvel instável.
- Paginar a fila do entregador (limite atual 50) e a do parceiro (limite atual 100), mostrando
  ao usuário quando existem mais registros.
- Reduzir nome/telefone/endereço antes da atribuição quando a operação crescer, seguindo
  minimização de dados da LGPD.

## 7. Leitura da produção

A auditoria executou `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, com timeout e sem
alterar dados.

| Medida | Resultado |
|---|---:|
| Rotas abertas | 1 |
| Entregas abertas da Matriz | 2 |
| Rotas/pedidos sem identidade do entregador | 0 |
| Divergências de estado/timestamp da Matriz | 0 |
| Pedidos em rota fechada ainda pendentes | 0 |
| Entregas concluídas lidas | 4 |
| Receita dessas entregas | R$ 200,90 |
| Receita de pneus | R$ 178,00 |
| Frete | R$ 22,90 |
| CMV conhecido | R$ 34,00 |
| Receita/CMV positivos ausentes ou divergentes no ledger | 0 |
| Divergências de entrega/recebível do parceiro | 0 |
| Acesso do papel do parceiro às tabelas de rota da Matriz | bloqueado |

Dois pedidos antigos de teste, `PED-0595` e `PED-0597`, têm valor zero, custo ausente e nenhum
movimento de estoque. Eles não geram receita e não representam divergência monetária.

Pendências de conciliação de dados de teste:

- `ROTA-0076`: combustível anotado R$ 52,00 e comprovante oficial R$ 50,00; estado
  `divergent`, aguardando confirmação do proprietário;
- `ROTA-0074`: combustível anotado R$ 58,00, comprovante rejeitado e nenhum valor oficial;
  estado `pending`;
- `ROTA-0075`: aberta; `pending` é o estado esperado até o fechamento.

## 8. Evidências executadas

| Bateria | Resultado |
|---|---|
| Unitários direcionados | **50/50**, 13 arquivos |
| Integração principal de rota/ledger/comprovantes | **32/32**, 4 arquivos |
| Integração parceiro + folha/comissão | **40/40**, 2 arquivos |
| Sondas descartáveis adicionais | **3/3**; matemática, estados, replay, competência e corrida |
| TypeScript | aprovado |
| Migrations | 191 verificadas; última `0190` |
| Produção somente leitura | concluída; zero divergência causal atual |

Os logs `terminating connection due to administrator command` exibidos ao encerrar algumas
provas vêm da parada do container PostgreSQL descartável depois dos testes; os arquivos
terminaram aprovados e isso não ocorreu na produção.

Auditoria reproduzível:

```powershell
$env:FAREJADOR_ENV='prod'
node --env-file=.env scripts/auditar-logistica-prod-readonly.cjs
```

## 9. Funcionalidades que mais agregariam valor

### Prioridade operacional

1. **Central de expedição com várias rotas:** uma coluna por entregador, arrastar pedido,
   atribuir/reatribuir e enxergar todas as rotas simultaneamente.
2. **Tentativa e retorno físico:** registrar falha, pneus recusados por linha, o que voltou ao
   veículo e o check-in real na loja antes de liberar estoque.
3. **Acerto da rota:** dinheiro cobrado, Pix/cartão/dinheiro por parada, diferença, despesa e
   fechamento de caixa do entregador.
4. **Modo offline com fila idempotente:** app continua registrando ações sem sinal e sincroniza
   sem duplicar quando a internet volta.

### Ganho comercial e gestão

5. **Comprovante de entrega:** foto ou assinatura simples e horário; localização apenas se
   houver necessidade e base de privacidade definida.
6. **Aviso ao cliente:** “saiu para entrega”, previsão e confirmação pelo WhatsApp.
7. **Veículo e odômetro:** moto/carro da rota, continuidade de km, consumo por km, manutenção
   e custo por veículo.
8. **Roteirização:** ordenar paradas, abrir trajeto completo no Maps/Waze e medir km previsto
   versus realizado.
9. **Indicadores úteis:** primeira tentativa, recusas por motivo/medida, prazo prometido,
   custo por entrega, margem por rota, produtividade por entregador e pneus que voltaram.

## 10. Sequência recomendada de correção

1. Corrigir replay e máquina de estados do parceiro, incluindo retorno físico.
2. Corrigir competência da entrega da Matriz e acrescentar prova de virada de mês.
3. Unificar rota administrativa e app pelo `courier_collaborator_id`.
4. Tornar a tela realmente multirrota e corrigir identidade de cliente/reentrega.
5. Corrigir upload, corrida do limite e recuperação de rota fechada.
6. Corrigir Histórico, agregações no servidor e paginação.
7. Reexecutar unitários, integrações, matemática, concorrência e produção somente leitura.
8. Somente depois preparar migration/publicação e pedir ao responsável o deploy.

## 11. Adendo de correção — 21/08/2026

Por decisão do responsável, foram implementadas **somente as quatro correções bloqueadoras
e os oito problemas confirmados** desta auditoria. Nenhum endurecimento recomendado e
nenhuma funcionalidade sugerida nas seções 6 e 9 foi implementada.

### Resultado das 12 correções

| Achado | Situação depois da correção |
|---|---|
| L-B01 replay de entrega do parceiro | Replay terminal virou leitura idempotente: não regrava data, pagamento, entregador nem auditoria |
| L-B02 competência da entrega da Matriz | Entrega pendente não cria receita/CMV; ao entregar, ambos usam `delivered_at` |
| L-B03 rota administrativa sem identidade | A Matriz seleciona colaborador ativo de Entregas e grava `courier_collaborator_id` + nome derivado |
| L-B04 estoque liberado antes do retorno | Falha apenas segura a reserva; botão separado confirma o retorno físico e só então cancela/libera |
| L-P01 primeira rota apenas | Tela permite escolher e operar qualquer rota aberta e continua permitindo abrir rota para outro entregador |
| L-P02 cliente de balcão sem identidade | App do entregador usa contato Chatwoot ou cliente de balcão, conforme a origem real |
| L-P03 entregador antigo na reentrega | Recolocar limpa rota e entregador; nova rota sobrescreve o nome pelo cadastro vinculado |
| L-P04 upload devolvendo 500 | Limite e duplicidade agora viram respostas controladas também no app do entregador |
| L-P05 corrida 49 + 2 = 51 | Rota é serializada no código e trigger do banco impõe o teto de 50 em qualquer caminho |
| L-P06 últimos 7 olhando o futuro | Histórico usa hoje menos seis dias; agenda operacional continua olhando o futuro |
| L-P07 indicadores truncados | Servidor entrega todos os pedidos e rotas dos últimos 30 dias, sem os limites 30/10 |
| L-P08 rota fechada sem novo upload | Resultado pendente/rejeitado oferece anexar o comprovante correto na própria rota fechada |

### Evidência pós-correção

| Bateria | Resultado |
|---|---|
| Testes unitários completos | **1.232/1.232**, 244 arquivos |
| Integração completa PostgreSQL 17 | **249/249**, 46 arquivos |
| Regressão direcionada da Logística | **19/19 unitários + 62/62 integrações** |
| TypeScript e build de produção | aprovados |
| JavaScript dos módulos alterados | sintaxe aprovada |
| Migrations | **192 verificadas**; última `0191`; manifesto SHA-256 íntegro |
| Migration do zero | aprovada dentro da integração completa em bancos descartáveis |

### Preparação material do ambiente

- Backup pré-`0191`: `farejador-pre-0191-20260821-014744.dump`, 4.960.069 bytes,
  legível pelo `pg_restore`, SHA-256
  `ec08c387b4b9eb600003bb637e9bc1632f13ba83c561d0da932e38b3a6de0f15`.
- A migration `0191` passou primeiro em dry-run transacional com rollback e depois foi
  aplicada com `COMMIT` em 21/08/2026, antes do deploy do runtime.
- Foram confirmados materialmente o wrapper e a função-base do cancelamento, o wrapper e
  a função-base da reconciliação, o trigger ativo do limite de comprovantes e as permissões.
- A reconciliação de `prod` retornou zero nos 21 contadores. O ambiente isolado `test`
  manteve nove ajustes de inventário históricos sem ledger, anteriores a esta entrega;
  nenhuma linha foi apagada ou misturada com `prod`.

Os logs `terminating connection due to administrator command` continuam sendo apenas o
encerramento intencional dos PostgreSQL descartáveis depois de cada grupo aprovado.

### Veredito pós-correção

**LOGÍSTICA APROVADA EM CÓDIGO, BANCO, INTEGRAÇÃO, MATEMÁTICA, SEGURANÇA E CONCORRÊNCIA
PARA PUBLICAÇÃO.** A migration `0191` já está aplicada e confirmada materialmente. Ainda não
é uma aprovação do runtime novo em execução: o código precisa ser publicado/deployado pelo
fluxo autorizado e o smoke autenticado pós-deploy precisa confirmar Matriz, entregador e
parceiro.
