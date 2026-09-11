# Aplicações por medida e faixa de anos — 11/09/2026

## Resultado e limite da revisão

A aplicação técnica agora fica no banco, independente de marca, SKU e estoque.
O bot resolve a moto/ano/posição e executa a busca comercial pela medida encontrada.
Não é necessário duplicar a mesma aplicação para cada marca de pneu.

A lista recebida **não foi considerada integralmente correta**. Das 175 propostas
das tabelas das 24 medidas, 7 já estão cobertas integralmente pelas referências
confirmadas, 161 ficaram pendentes e 7 foram recusadas como propostas integrais.
Uma proposta pendente pode ter alguns anos confirmados; isso não valida sua faixa
inteira. Alternativas de balcão não viraram indicação original.

O lote aplicado contém 350 registros:

| Situação | Registros | Significado |
| --- | ---: | --- |
| Verificada, original | 182 | 19 aplicações agrupadas da revisão nova e 163 referências anteriores preservadas |
| Pendente | 161 | Propostas sem comprovação suficiente para toda a medida/versão/faixa indicada |
| Recusada | 7 | Propostas conflitantes ou incorretas; preservadas para revisão |

**182 não é o número de motos novas nem de propostas do Claude aprovadas.** Uma
aplicação identifica modelo, posição, medida e intervalo; a mesma família pode
ter várias aplicações. As 163 referências anteriores não foram todas reabertas
nesta revisão, e seus anos não foram ampliados.

## O que foi conferido novamente

Foram examinados 43 PDFs do acervo oficial brasileiro da Yamaha. O arquivo
`scripts/data/catalog-manual-review-20260911.json` guarda 98 observações de
ano/posição, com URL, página e SHA-256 de cada PDF. Só anos-modelo consecutivos
observados foram unidos em faixa. A ficha oficial já existente da NMAX 2026
completa a consulta dessa família.

| Família | Anos conferidos nesta revisão | Dianteiro | Traseiro |
| --- | --- | --- | --- |
| NMAX 160 ABS / Connected | 2017–2025 | 110/70-13 | 130/70-13 |
| Fazer FZ25 ABS / Connected | 2018–2025 | 100/80-17 | 140/70-17 |
| Crosser 150 | 2016–2026 | 90/90-19 | 110/90-17 |
| Fluo ABS / Hybrid Connected | 2023–2026 | 100/90-12 | 110/90-12 |
| Fazer YS150 | 2015–2025 | 2.75-18; manuais 2022–2025 também registram 80/100-18 | 100/80-18 |

Índices de carga/velocidade, montagem e mudanças de versão permanecem separados
nas aplicações. A tabela acima resume as dimensões, sem substituir esses dados.
O dianteiro da YS150 possui duas opções explícitas em alguns manuais; não foi
feita conversão automática de polegadas para milímetros.

Fontes consultadas: [acervo oficial Yamaha](https://www.yamaha-motor.com.br/manuais-e-catalogos),
[manual NMAX 2018, página 102](https://www.yamaha-motor.com.br/midia/manual_nmaxabs_2018.pdf#page=102),
[manual Crosser 2016, página 97](https://www.yamaha-motor.com.br/midia/manual_crosser150_2016.pdf#page=97),
[manual Fazer YS150 2025, página 94](https://www.yamaha-motor.com.br/midia/manual_fazerys150_2025.pdf#page=94).
As demais URLs e páginas estão no arquivo de pesquisa.

A faixa integral proposta para PCX 150 foi recusada: o
[manual Honda PCX 2015](https://www.honda.com.br/sites/cbw/files/2016-08/PCX%202015.pdf)
especifica 90/90-14 na frente e 100/90-14 atrás. Não se pode estender o par da
geração posterior a todo o período 2013–2022. Essa constatação não cadastrou
automaticamente uma faixa alternativa de vários anos.

## Como o bot e o catálogo usam os dados

- `commerce.vehicle_measure_applications` contém as aplicações e propostas.
- Só `status='verified'` e `application_kind='original'` entram na consulta do bot
  e no catálogo do parceiro. As leituras são isoladas por ambiente.
- Vínculos específicos de produto já aprovados continuam sendo consultados
  primeiro. Sem vínculo, o bot resolve a aplicação técnica por medida.
- O primeiro e o último ano da faixa estão incluídos. Ano nulo não significa
  vigência universal. O bot não empresta a medida de outra geração.
- A ausência do ano só é dispensada para famílias explicitamente revisadas e
  sem diferença de medida na posição solicitada. Neste lote, isso foi comprovado
  para a NMAX brasileira 2017–2026; não foi marcado 2016 como confirmado.
- Resolvida a medida, a ferramenta executa a busca comercial normal, preservando
  condição, posição, localização, preços e regras de estoque. Posição de SKU não
  preenchida continua encontrável; posição oposta explicitamente cadastrada fica
  excluída. Aplicação técnica não homologa construção/índices/montagem do SKU.
- Consulta sem localização resolvida continua pedindo localização antes de
  afirmar disponibilidade. Erro de consulta não vira falta de estoque.
- No painel da Matriz, as pendências aparecem em **Catálogo → Compatibilidades**,
  após as aplicações confirmadas, no bloco recolhível de propostas em revisão.
  Esse bloco informa o motivo; não possui aprovação automática em massa.

Não foram copiados estoques, preços, vínculos ou cadastros do banco antigo. Os
números de estoque e as recomendações de compra do documento recebido não foram
tratados como dados do banco atual.

## Aplicação e publicação

A migration `0225_vehicle_measure_applications.sql` e o lote
`catalog-measure-applications-20260911-v1` foram aplicados no banco atual,
ambiente `prod`, em 11/09/2026 às 16:31 UTC. O ledger registra seu checksum.
Produtos, preços, estoques e vínculos existentes não foram alterados pelo importador.

O código do bot e do painel depende de **deploy do commit desta entrega** para
entrar em uso online. A aplicação da migration sozinha não muda o comportamento
do processo online.
Não há variável de ambiente nova.

O importador abaixo é restrito ao banco atual, usa `DATABASE_URL` já existente,
gera snapshot antes da alteração e é idempotente. Sem `--commit`, termina com
rollback. Não substituir a conexão pelo banco antigo.

```powershell
node --import tsx --env-file=.env.novo scripts/import-vehicle-applications.ts --prod
node --import tsx --env-file=.env.novo scripts/import-vehicle-applications.ts --prod --commit
```

O lote insere IDs ausentes e não sobrescreve revisões posteriores. A migration
cria a estrutura; o importador é quem carrega os dados. Uma instalação nova
precisa receber a carga técnica no ambiente correto depois das migrations.
O importador operacional acima recusa outro projeto; a função de importação
reutilizável está em `scripts/vehicle-application-import.ts`.

Para uma futura limpeza com preservação dos catálogos, preservar também
`commerce.vehicle_measure_applications`, inclusive fontes, faixas e decisões de
revisão. A tabela não depende de IDs de produtos, então excluir/recriar SKUs
não apaga essas aplicações. Nenhuma limpeza de banco foi executada nesta tarefa.

Evidências locais, fora do Git:

- Snapshot: `.codex-tmp/backups/catalog-measure-applications-20260911-v1-2026-09-11T16-31-05-352Z-before.json`.
- SHA-256: `8517690ba1f4a25b1f5e09ef4ba2fe7b5f6e378ad87ffe1771dc42fd9bfb8bc7`.
- Relatório: mesmo prefixo, arquivo `-report.json`, estado `committed`.
- Consulta com dados reais: `tmp/catalog-review/current-db-verification.json`.

## Validação

- 130 testes unitários de aplicações, ferramenta, memória de produtos, catálogo
  da Matriz/parceiro e frontend passaram.
- 3 testes de integração com Postgres e todas as migrations passaram: importação
  idempotente, isolamento de ambientes, proteção de tabelas comerciais, rejeição
  de intervalos invertidos e permissões de leitura do parceiro.
- Build, typecheck e verificação dos 226 arquivos de migration passaram.
- Ajuste adicional de compra por medida: a escrita `130 70 13` segue a busca
  direta, sem exigir moto, ano, posição ou foto; localização continua necessária
  para afirmar disponibilidade. Os 44 testes de busca, lembretes e consistência
  do prompt passaram, assim como o typecheck. As propostas posteriores sobre
  pressão de fechamento e alternativas de marca ficam para outra entrega.
- Consulta somente de leitura no banco atual, usando o código local novo:
  NMAX 2018, 2026 e sem ano resolveram 130/70-13 traseiro e consultaram estoque;
  Crosser 2018 resolveu 110/90-17; CB250F 2021 preservou 140/70R17 na referência;
  NMAX 2030 não recebeu uma medida emprestada. O catálogo mostrou a NMAX 2018.
  Nessa consulta os produtos 130/70-13 estavam zerados. Sem localização resolvida,
  o resultado manteve `precisa_localizacao=true`.

Essas provas não são uma conversa com o bot já implantado, nem uma homologação
física dos pneus disponíveis. As 161 propostas pendentes continuam exigindo
conferência técnica antes de liberar toda a abrangência pedida na lista.
