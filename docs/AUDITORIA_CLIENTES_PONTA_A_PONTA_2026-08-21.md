# Auditoria ponta a ponta de Clientes — Matriz e parceiro

**Data:** 21/08/2026
**Escopo:** Todos, Leads, Compradores, Recompra, Parceiros, identidade/privacidade
dormente, cadastro de clientes do parceiro, PDV, Bot, Chatwoot, Vendas, Estoque,
Logística, Financeiro, Marketing, banco, permissões e navegador.

## Veredito executivo

A seção tinha quatro falhas funcionais confirmadas: o quadro de Leads não permitia
movimentação manual nem limpeza recuperável; o VIP tinha regras diferentes entre Matriz e
parceiro; compras ainda não realizadas podiam influenciar o cliente do parceiro; e o Bot
aceitava `John Doe` como nome verdadeiro. Havia ainda corte silencioso de 30 cards por
coluna e dois indicadores de atividade que envelheciam incorretamente.

As correções estão concluídas em código. A migration `0196_customer_lead_board.sql` é
aditiva e preserva integralmente contato, conversa, mensagens, pedido e fatos financeiros.
Ela foi validada desde o zero em PostgreSQL 17 descartável, junto com a regressão completa
das integrações, e aplicada no banco-alvo depois de backup verificável. Esta auditoria
**aprova código e banco para publicação**; restam o deploy manual e o smoke pós-deploy.

## Mapa das fontes e relações

| Superfície | Fonte canônica | Relações verificadas |
|---|---|---|
| Matriz / Todos | `core.contacts`, `commerce.customers`, `commerce.partner_customers`, `commerce.wholesale_customers` | Chatwoot, balcão, parceiro e atacado |
| Matriz / Leads | última `core.conversations` por contato + fatos/classificações de `analytics.*` | Bot, Conversas, orçamento e pedido de Vendas |
| Compradores | pedidos realizados de Matriz, parceiro e atacado | Vendas, entrega/retirada, Estoque e Financeiro |
| Recompra | última compra realizada e ticket médio | Vendas e campanhas futuras de relacionamento |
| Parceiros | `network.partners` + resumo de atacado liquidado/recebido | Rede, Atacado e Financeiro |
| Identidade e privacidade | `commerce.customer_identities` e vínculos | owner-only, revisão humana e separação reversível |
| App / Clientes | `commerce.partner_customers` | PDV, entrega, retirada, contas e histórico local |

O VIP passa a usar uma regra única: **3 compras realizadas**. Não contam pedido cancelado,
entrega ainda não entregue nem retirada ainda aguardando o cliente. No atacado destinado a
parceiro, só conta o acerto recebido/liquidado. A estrela não altera preço, desconto,
comissão, estoque ou financeiro; é uma classificação de relacionamento derivada dos fatos.

## Problemas confirmados e correções

### 1. `John Doe` no Bot

Na leitura somente leitura do banco de produção, 16 de 29 contatos ativos tinham exatamente
`John Doe`; 15 dos 16 vieram do inbox 34, canal Facebook. Os eventos brutos imutáveis já
chegam do Chatwoot com esse nome em `contact_created`, `contact_updated`, mensagens e
conversas. O normalizador não inventou o valor.

O Atendente V2, porém, não considerava `John Doe` um placeholder e instruía o modelo a usar
“John” desde o primeiro turno. Foi criado um filtro compartilhado que recusa `John Doe`,
`Jhon Doe`, `Jane Doe`, telefone e placeholders antigos. O Bot agora trata o nome como
desconhecido; Clientes mostra `Cliente sem nome` e o aviso `Nome pendente no Chatwoot`, sem
alterar nem apagar o evento bruto.

O defeito de origem precisa ser corrigido também no inbox Facebook do Chatwoot. A orientação
oficial é reautorizar a página com todas as permissões; o histórico público do próprio
Chatwoot associa esse sintoma à falta de acesso de produção ao perfil do usuário/Business
Asset User Profile Access.

### 2. VIP divergente

Antes, três fontes da Matriz devolviam `false`, a fonte parceiro lia uma coluna legada que o
próprio app não usava, e o app calculava três compras a partir de uma lista truncada de
vendas. Agora Matriz e parceiro calculam no servidor com a mesma régua de 3 compras
realizadas. A interface do parceiro usa os totais agregados do banco; a estrela continua
correta mesmo quando o feed visual de vendas não contém todo o histórico.

### 3. Movimentação do Lead

O card pode ser arrastado no desktop ou movido por um seletor acessível no celular. As
colunas manuais são Novo, Em atendimento, Orçamento e Perdido. `Convertido` permanece
automático e só vence a coluna manual quando existe venda confirmada, evitando conversão
fictícia para melhorar indicador.

Cada alteração exige sessão da Matriz, mesma origem no navegador, chave de idempotência e
versão esperada. Duas telas editando o mesmo card não sobrescrevem silenciosamente uma à
outra. Estado e evento de auditoria são gravados na mesma transação e separados por
`environment`.

### 4. Limpeza sem apagar história

“Apagar card” virou **Arquivar card**. Arquivar esconde o lead da fila ativa, mas mantém
contato, conversa, mensagens, classificações, pedido, estoque e financeiro. A lista
Arquivados permite localizar e restaurar. O banco usa `ON DELETE RESTRICT`; não existe
cascata a partir do quadro.

Cada coluna mostra 12 cards inicialmente e oferece `Mostrar mais`, em vez de esconder tudo
depois do trigésimo card. Ao abrir Arquivados, o período muda para Todo período para que um
lead antigo não desapareça justamente da área de recuperação.

### 5. Verdade matemática e integrações

- entrega da Matriz só entra em compras, total, ticket, margem e última compra depois de
  `delivery_status='delivered'`;
- no parceiro, entrega aberta, retirada reservada e cancelamento não contam como compra;
- o helper visual de saída física do parceiro também deixou de contar `awaiting_pickup`;
- Compradores, Recompra e VIP leem a mesma realização usada por Estoque e Financeiro;
- atividade do cliente parceiro considera pedidos recentes, não apenas a data de edição do
  cadastro;
- comprador de atacado sem compra não permanece “ativo” para sempre;
- zero vínculos órfãos de cliente foram encontrados nas vendas atuais da Matriz e parceiro.

## Produção lida sem mutação

| Controle agregado | Resultado |
|---|---:|
| Contatos Chatwoot | 29 |
| Conversas | 30 |
| Nomes `John/Jhon/Jane Doe` | 16 |
| Clientes de balcão | 7 |
| Clientes locais de parceiro | 0 |
| Compradores de atacado | 3 |
| Entregas abertas da Matriz indevidamente realizáveis | 0 |
| Vendas locais não realizadas atuais | 0 |
| Vínculos órfãos Matriz / parceiro | 0 / 0 |

Todos os comandos dessa inspeção usaram transação repetível somente leitura e terminaram
com rollback. Nenhum nome, telefone ou conteúdo de conversa foi copiado para o relatório.

## Segurança, testes e navegador

| Bateria | Resultado atual |
|---|---|
| TypeScript | aprovado |
| Build de produção | aprovado |
| Sintaxe dos módulos JavaScript alterados | aprovada |
| Unitários completos | **1.263/1.263**, 255 arquivos |
| Testes dirigidos novos | placeholders, regra VIP, sobreposição de coluna, concorrência, auditoria, UI e parceiro aprovados |
| Manifesto | 197 migrations; última `0196`; gap histórico `0071` documentado |
| Prova dos painéis | parceiro 597 propriedades; Matriz 1.100; 93 contratos e 240 rotas aprovados |
| Dependências | `npm audit --audit-level=high`: 0 vulnerabilidades |
| Navegador local | mover, estrela VIP, nome pendente, arquivo e restauração aprovados |
| Ensaio SQL no banco-alvo | `0196`, consulta real de 39 fichas/7 parceiros e isolamento cruzado `23503`: aprovados; rollback confirmado |
| Integração específica de Clientes em PostgreSQL 17 descartável | **4/4**, 2 arquivos: migration, movimentação/arquivo, isolamento e VIP aprovados |
| Regressão completa em PostgreSQL 17 descartável | **264/264**, 50 arquivos em 5 lotes: aprovada |
| Produção | backup pré-`0196` validado; dry-run e commit aprovados; 0 linha inválida, cruzada ou de teste persistida |

## Insights não implementados

1. A visão atual ainda limita cada fonte da Matriz a 500 clientes e o cadastro do parceiro a
   300. Não afeta a base atual, mas deve virar paginação por cursor antes de atingir 80% do
   limite, sem aumentar indefinidamente o payload.
2. O sistema canônico de identidade já existe, mas está dormente e vazio. Enquanto ele não
   for habilitado com revisão humana, o mesmo ser humano em Chatwoot, balcão e parceiro pode
   aparecer em fichas separadas e o VIP será correto por ficha, não somado entre fontes.
3. SLA por coluna, lembrete automático de lead parado, motivo estruturado de perda e score de
   propensão seriam próximos ganhos de produto. Não foram implementados nesta auditoria.
4. Depois de corrigir a permissão do Facebook, convém executar uma reconciliação controlada
   de nomes no Chatwoot. O Farejador deve receber a correção por evento; não se deve reescrever
   `raw_events`.

Backup pré-migration: `farejador-prod-pre-0196-20260821203005.dump`, 4.481.418 bytes,
2.648 entradas legíveis pelo `pg_restore`, SHA-256
`59d3199e5116d6f844d463797e068eb3e8211132ab0089468b34d2be24a575b2`.

## Adendo — deploy e investigação do Chatwoot

### Deploy de Clientes

- PR `#70` incorporada à `main` no SHA
  `22ea499c7a3bd98d81a3daf0733042f39ed87dd1`;
- GitHub Actions da PR e do merge: aprovados;
- Coolify importou o SHA esperado, construiu uma imagem nova e concluiu o rolling update em
  21/08/2026, 20:52–20:53 (America/Sao_Paulo);
- `/livez`, `/readyz` e `/healthz`: HTTP 200 com o SHA implantado;
- banco principal, schema e banco restrito do parceiro: `ok`;
- páginas da Matriz e da unidade Rio do Ouro: HTTP 200;
- módulos implantados do Kanban e do VIP do parceiro: HTTP 200, com os marcadores da versão
  nova presentes;
- API de Clientes sem sessão: HTTP 401, como exigido.

O aviso do Coolify sobre `NODE_ENV=production` não bloqueou a entrega: a construção e o
container terminaram com sucesso. O smoke visual autenticado continua pendente porque o
navegador de auditoria não possuía sessão normal da Matriz; nenhum token emergencial foi
usado para contornar o login.

### Diagnóstico direto da inbox Facebook

A API do Chatwoot da conta operacional foi consultada somente para leitura. Nenhuma
credencial é reproduzida neste documento. Foram confirmadas as inboxes WhatsApp `30`,
Instagram `32` e Facebook `34`; a origem dos nomes genéricos é a inbox Facebook `34`.

Na própria API do Chatwoot:

- a busca retornou 15 contatos `John Doe`, todos ligados à inbox `34`;
- as 15 conversas existentes dessa inbox também apresentaram `John Doe` como remetente;
- os 15 vínculos possuem `source_id` do Facebook, mas nenhum dos contatos possui e-mail,
  identificador canônico, avatar, atributo adicional ou atributo personalizado;
- os cadastros afetados vão de 18/06/2026 a 19/08/2026, logo não é um evento isolado;
- a inbox possui IDs da página/Instagram e informa `reauthorization_required=false`.

`reauthorization_required=false` prova apenas que o Chatwoot não marcou a conexão como
expirada; não prova que a Meta liberou leitura do perfil. A evidência mostra que o Facebook
entrega o identificador, mas o Chatwoot não obtém os dados do perfil e grava o fallback
`John Doe`. O Farejador não criou o nome. A defesa implantada impede o Bot de chamar o
cliente de John e mostra `Cliente sem nome` até chegar um nome confiável.

### Pendências operacionais

1. Reautorizar a inbox `Facebook - 2W Pneus` no Chatwoot usando uma conta administradora da
   página e conceder todas as permissões solicitadas pela Meta.
2. Como token de API e segredo HMAC foram expostos no canal de trabalho, rotacioná-los. A
   troca do HMAC deve ser simultânea no webhook do Chatwoot e no Coolify para não interromper
   a ingestão; o token usado pelo runtime também deve ser atualizado onde estiver configurado.
3. Depois da reautorização, criar ou aguardar um contato novo e confirmar que nome e avatar
   chegam ao Chatwoot e ao Farejador. Os 15 contatos antigos devem ser reconciliados de forma
   controlada; `raw_events` nunca deve ser reescrito.
4. Executar o smoke visual com sessão normal: abrir Clientes → Leads, mover um card de teste,
   arquivar, restaurar e conferir `★ VIP` na Matriz e no parceiro.

O `.env` local desta estação ainda referencia uma configuração legada por HTTP/conta `1`;
ele não foi alterado e não deve ser confundido com a configuração operacional da conta `2`
nem usado como prova da configuração atual do Coolify.

**Veredito atualizado:** Clientes está aprovada em código, banco, integração e deploy
técnico. O nome real do Facebook permanece uma pendência externa de autorização
Chatwoot/Meta, protegida no runtime pelo tratamento de placeholder. A homologação visual
autenticada e a rotação dos segredos continuam obrigatórias.
