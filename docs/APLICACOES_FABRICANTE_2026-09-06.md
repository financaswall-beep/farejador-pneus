# Aplicações por moto em uso no código — 06/09/2026

## Entrega

O catálogo da Matriz e da operação das unidades passa a mostrar 147 aplicações de 73 configurações brasileiras: 145 da pesquisa inicial e duas da Fazer FZ25 Connected 2025 confirmadas nesta etapa. Cada registro contém moto, referência de ano/versão, posição, medida original, índices/montagem quando informados e link do fabricante. São 13 marcas de motos, incluindo scooters, aros 15/16 e medidas largas. Os casos internacionais, conflitantes ou sem confirmação suficiente não foram liberados.

Essa base é um catálogo público de referência incluído no código, não uma nova tabela operacional: `src/shared/data/vehicle-tire-research-20260906.json`. Um teste garante que os 83 registros originais continuam iguais à pesquisa em `scripts/data/catalog-fitment-research-20260906.mjs`; o registro adicional M084 vem do [manual oficial Yamaha 2025](https://stgmkpprd.blob.core.windows.net/yamaha-motor-site/manual_fazerfz25abs_2025.pdf), ligado pela página brasileira do modelo. Não há migration nem alteração de variáveis.

## Consulta do bot

`buscar_compatibilidade` preserva as consultas de produtos já associados e o roteamento/estoque existentes. Se não encontrar uma moto ou vínculos de produtos aprovados, consulta a base de aplicações do fabricante. Assim, consegue responder a medida sem inventá-la nem depender de um produto já cadastrado.

O retorno distingue explicitamente aplicação de medida de produto confirmado; não fabrica SKU, preço ou estoque. Ambiguidade de moto/versão e ano indefinido são sinalizados. A busca de preço e estoque continua sendo feita pelas ferramentas existentes. Fontes sem ano delimitado nunca significam todos os anos, e R/ZR/B/polegadas são preservados na especificação original.

O deploy é necessário para disponibilizar essa consulta e as novas seções do catálogo. O deploy não executa scripts de manutenção nem promove as 62 candidatas a produtos homologados.

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
