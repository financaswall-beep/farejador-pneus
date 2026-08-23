# Handoff — Catálogo inicial e compatibilidade de motos

Data: 23/08/2026
Estado: implementado e testado; migration `0202` aplicada no banco novo de São
Paulo (`farejador-matriz`); **deploy ainda não executado**.

## Problema resolvido

O banco novo começava com motos cadastradas, mas sem produtos, medidas ou
compatibilidades. Existia um ciclo impossível: Compras recusava medida fora do
Catálogo e o Catálogo só conseguia criar produto depois que Compras já tivesse
criado estoque.

Agora o dono pode criar primeiro o dado mestre no Catálogo. Essa operação cria
somente `commerce.products`, `commerce.tire_specs` e, se informado, o preço
oficial temporal. Ela **não cria** estoque, compra, custo, caixa, receita, lucro,
pedido ou ledger. O produto só fica vendável quando preço e saldo físico
recebido existirem ao mesmo tempo.

## Fluxo implementado

1. Catálogo → **Novo produto**.
2. Informar medida normalizada, marca, condição, código, nome e preço opcional.
3. Salvar no Catálogo ou salvar e voltar para Compras com medida/marca/condição
   preenchidas; fornecedor, quantidade e custo continuam obrigatórios.
4. Em Compatibilidade, o dono pesquisa uma das motos normalizadas já existentes.
5. Uma homologação direta é propagada, em transação única, para todos os
   produtos ativos da mesma medida, independentemente de marca ou condição.
6. Uma fonte encontrada na internet entra como candidata pendente com URL e
   resumo. O Bot não lê a candidata. Aprovar promove para todos os produtos da
   medida; rejeitar preserva o histórico.
7. Remover uma associação também remove de toda a medida e exige motivo.

Não foi implementado robô autônomo de pesquisa na internet. Fontes externas
podem estar erradas; por isso a etapa de aprovação humana é obrigatória.

## Integrações preservadas

- **Compras:** medida recém-cadastrada deixa de ser recusada; salvar e voltar
  apenas preenche a variante, sem registrar compra.
- **Estoque e custo:** continuam surgindo somente no recebimento real. A média
  ponderada e o ledger não foram alterados.
- **Caixa/Vendas/Financeiro:** produto sem preço ou sem saldo permanece bloqueado.
  Criar a ficha técnica não altera resultado por competência nem caixa.
- **Bot:** se reconhece a moto mas não encontra fitment aprovado, responde
  `compatibilidade_nao_cadastrada` e pede a medida escrita no pneu. Não adivinha.
- **Parceiro:** a busca read-only do Catálogo central passa a localizar pela
  coluna técnica `tire_size`; preço e estoque local continuam isolados.
- **Segurança:** leitura para usuários autenticados; cadastro, homologação,
  remoção, criação e revisão de candidata são exclusivos do dono.

## Migration 0202

Arquivo: `db/migrations/0202_catalog_bootstrap_fitment_workflow.sql`.

- adiciona evidência, origem e sugestão à fila `fitment_discoveries`;
- cria o filme N:N `fitment_discovery_promotions`;
- transforma os UUIDs promovidos em referências históricas validadas na gravação,
  para uma correção posterior não apagar nem bloquear o filme da aprovação;
- mantém guardas de ambiente prod/test e ambiente imutável;
- cria `commerce.catalog_fitment_measure_gaps`, que deve retornar zero linhas;
- concede ao app parceiro somente `SELECT` em `commerce.tire_specs`;
- não popula dados automaticamente.

Ordem obrigatória de publicação: **aplicar 0202 primeiro; depois fazer deploy do
código**. A primeira etapa já foi concluída no banco novo. O código novo consulta
as colunas criadas pela migration.

Pós-migration remoto: tabela de promoções e view de diagnóstico presentes,
`farejador_partner_app` com `SELECT` em `tire_specs` e zero linhas em
`commerce.catalog_fitment_measure_gaps`.

## Provas executadas

- `npm run typecheck`: aprovado.
- `npm run build`: aprovado.
- `npm test`: **1.306/1.306** testes unitários aprovados.
- 9 arquivos críticos de integração (Catálogo, Bot, Compras, estoque, parceiro,
  venda e ledger): **44/44** cenários aprovados.
- integração nova pós-refatoração: **2/2** cenários aprovados.
- replay de banco vazio até 0202: **203 migrations** aprovadas em PostgreSQL 17.
- manifesto/checksum: aprovado; gap histórico único 0071 preservado.
- `npm run prova-painel`: paridade Alpine, contratos, 252 rotas, estáticos e
  fiscal de tamanho aprovados.

A conexão do navegador local não ficou disponível; portanto o smoke visual real
do drawer não foi declarado como feito.

## Smoke obrigatório após deploy

1. Abrir Catálogo e criar uma variante sem preço; confirmar estoque e financeiro
   inalterados.
2. Criar outra com preço; confirmar que continua bloqueada sem estoque.
3. Salvar e ir para Compras; conferir variante preenchida e custo em branco.
4. Associar uma moto e conferir a mesma quantidade de motos em outra marca da
   mesma medida.
5. Registrar fonte web; confirmar status Pendente e ausência no resultado do Bot.
6. Aprovar; consultar o Bot pela moto e conferir somente produtos com preço/saldo.
7. Remover a associação com motivo; confirmar remoção em todas as marcas da
   medida e preservação da candidata aprovada no histórico.
8. No parceiro, pesquisar o Catálogo central por `90/90-18`.
9. Consultar `commerce.catalog_fitment_measure_gaps`; resultado esperado: zero.

## Rollback

Se a tela falhar, reverter somente o deploy do código. A migration é aditiva e
pode permanecer aplicada. Não apagar candidatas nem o filme de auditoria.
