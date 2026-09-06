# Aplicações por moto em uso no código — 06/09/2026

## Entrega

O catálogo da Matriz e da operação das unidades passa a mostrar 147 aplicações de 73 configurações brasileiras: 145 da pesquisa inicial e duas da Fazer FZ25 Connected 2025 confirmadas nesta etapa. Cada registro contém moto, referência de ano/versão, posição, medida original, índices/montagem quando informados e link do fabricante. São 13 marcas de motos, incluindo scooters, aros 15/16 e medidas largas. Os casos internacionais, conflitantes ou sem confirmação suficiente não foram liberados.

Essa base é um catálogo público de referência incluído no código, não uma nova tabela operacional: `src/shared/data/vehicle-tire-research-20260906.json`. Um teste garante que os 83 registros originais continuam iguais à pesquisa em `scripts/data/catalog-fitment-research-20260906.mjs`; o registro adicional M084 vem do [manual oficial Yamaha 2025](https://stgmkpprd.blob.core.windows.net/yamaha-motor-site/manual_fazerfz25abs_2025.pdf), ligado pela página brasileira do modelo. Não há migration nem alteração de variáveis.

## Consulta do bot

Na versão `manufacturer-applications-20260906-v2`, `buscar_compatibilidade` prioriza as aplicações verificadas por moto/ano/posição, sem depender de aprovações de produtos no banco. Quando não existe referência, preserva a consulta anterior de produtos associados. Assim, uma correspondência aproximada antiga não substitui a medida documentada.

O retorno distingue explicitamente aplicação de medida de produto confirmado; não fabrica SKU, preço ou estoque. Ambiguidade de moto/versão e ano indefinido são sinalizados. A busca de preço e estoque continua sendo feita pelas ferramentas existentes. Fontes sem ano delimitado nunca significam todos os anos, e R/ZR/B/polegadas são preservados na especificação original.

O deploy é necessário para disponibilizar essa consulta e as novas seções do catálogo. O deploy não executa scripts de manutenção nem promove as 62 candidatas a produtos homologados.

## Uso sem aprovação individual

O retorno do bot indica `referencia_em_uso=true`, `requer_aprovacao_manual_da_referencia=false` e `estoque_consultado=false`. Com modelo/ano/posição identificados na fonte, prepara `consultas_de_produto` por medida e condição. A ferramenta `buscar_produto` continua responsável pelos produtos, preços, estoque e localização; referências sozinhas não garantem disponibilidade. Não é aplicada uma posição de produto inventada ao cadastro genérico.

Na tela, as cópias exatas da pesquisa já presentes na base passam para um histórico recolhido, sem solicitar o clique de aprovação. O histórico original permanece acessível, e pesquisas divergentes/rejeitadas ou revisões anteriores não são ocultadas por esse reconhecimento. A API apenas adiciona o metadado de leitura `active_reference`: nenhum status no banco é promovido ou reescrito.

Conferência somente leitura no banco atual: 62 de 62 registros reconhecidos. Nesta etapa não houve escrita no banco, nova migration, alteração de variáveis ou separação por modelo comercial de pneu. A conferência do produto específico continua com a equipe antes da venda/montagem.

## Correção já aplicada no banco atual

Em 06/09/2026, às 18:10 UTC, foram removidos 10 vínculos antigos incorretos:

- Três produtos 90/90-10 associados como traseiros à Burgman 125i.
- Três produtos 90/90-10 associados como traseiros à Lindy 125.
- Quatro produtos 140/70-17 associados a ambos os eixos da CB 300F Twister.

Os manuais da [Burgman](https://assets.suzukimotos.com.br/storage/manual-proprietario/MANUAL-DO-PROPRIETARIO-SUZUKI-BurgmanI.pdf) e da [Lindy](https://haojuemotos.com.br/storage/manual-proprietario/MANUAL-DO-PROPRIETARIO-HAOJUE-LINDYQ.pdf) registram 90/90-10 na dianteira e 100/90-10 na traseira. A [Honda](https://saladeimprensa.honda.com.br/releases/honda-cb-300f-twister-2023-novo-design-motor-atualizado-e-mesma-confiabilidade) distingue expressamente o 150/60R17 traseiro da CB 300F do 140/70R17 da CB 250F.

A retirada foi transacional, com cópia completa recuperável dos vínculos e 10 eventos de auditoria `catalog_incorrect_fitment_removed`. Backup local ignorado pelo Git: `.codex-tmp/backups/catalog-fitment-corrections-20260906-v1-2026-09-06T18-10-06-006Z.json`.

Conferência pós-COMMIT: quatro vínculos não afetados permaneceram; as 62 candidatas foram preservadas; os 48 produtos e suas especificações permaneceram iguais. Não houve escrita em estoque, preços, pedidos, financeiro, raw/core ou estado do bot.

## Validação

Testes cobrem Fan/Titan por ano, CB 250F/300F, Burgman/Lindy por posição, XMAX/Citycom, Mottu com alternativas expressas, medidas largas, rejeição de conflitos e manutenção das inscrições técnicas. A integração em Postgres temporário executa a ferramenta real do bot, consulta o catálogo, valida ausência de efeitos em estoque e testa a correção com auditoria/rollback. Build, TypeScript, paridade dos painéis, teto de arquivos e manifesto de migrations foram verificados.

Verificação final: 1.246 testes unitários dos módulos admin/parceiro/atendente e oito testes de integração de importação/correção e catálogo operacional passaram. A carga do JavaScript compilado confirmou 147 aplicações, 73 configurações e 13 marcas. Não foi realizada validação visual em produção nem deploy nesta etapa.

Verificação da versão sem cliques: 1.261 testes unitários e dez testes de integração passaram, incluindo reconhecimento do lote, preservação de rejeições, consulta sem SQL de aprovação e busca dos produtos por medida com posição do SKU não preenchida. Build, tipos, paridade e teto de arquivos passaram. Sem conversa real/LLM ou validação visual em produção nesta etapa.
