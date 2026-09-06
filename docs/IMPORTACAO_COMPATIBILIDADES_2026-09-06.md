# Importação da pesquisa de compatibilidades — 06/09/2026

Atualização posterior: a base de aplicações do fabricante foi integrada ao catálogo e à consulta do bot, e os 10 vínculos incorretos foram retirados com auditoria. Veja `docs/APLICACOES_FABRICANTE_2026-09-06.md`. O relato abaixo registra a importação inicial das candidatas, não homologação de SKU.

## Resultado aplicado e verificado

Lote `catalog-fitment-research-20260906-v1`, produção atual (São Paulo):

- 62 candidatas **pendentes**, referentes a 49 configurações de motos e 20 medidas do catálogo.
- 49 registros de modelo/versão de referência criados sem ampliar os anos dos registros antigos.
- 62 eventos de auditoria de candidatas e 49 de modelos.
- Nenhuma compatibilidade homologada automaticamente.
- Os 48 produtos/especificações e os 14 vínculos anteriores permaneceram iguais na verificação pós-COMMIT.
- Nenhuma escrita em estoque, preços, pedidos, financeiro, bot, `raw.*` ou `core.*`.
- Sem migration nova; usa o fluxo existente da migration 0202. A importação de dados não depende de deploy.

No painel: **Catálogo → Compatibilidades do produto → Fila de pesquisa**.
As candidatas ainda não são usadas pelo bot para recomendar produtos.

## O que ficou fora

A pesquisa versionada tem 83 configurações e 165 aplicações de posição/medida explicitadas:

- 62 cruzamentos nominais cadastrados para revisão.
- 83 aplicações brasileiras confirmadas na fonte, mas sem produto naquela medida no catálogo atual.
- 20 aplicações que precisam de revisão da fonte, mercado ou construção; não importadas.

Os dois traseiros sem medida resolvida (Classic 350 e Maxsym 400 GT da página 2026) permanecem documentados como conflitos e não entram na contagem de 165. Não foram criados produtos fictícios para acomodar medidas ausentes.

## Pendências para liberação ao bot

Os 48 produtos estavam sem posição, construção, carga, velocidade e modelo comercial do pneu. A pesquisa comprova especificações de motos; isso não homologa um produto genérico da mesma dimensão.

Para cada produto, conferir modelo comercial, inscrições laterais, posição permitida, construção, índices, montagem e ano/versão da moto. R/ZR foram preservados na pesquisa e nas evidências; sua ocultação visual não transforma um pneu radial em diagonal. Polegadas não são convertidas automaticamente em medidas métricas. Datas de comunicado não viraram anos-modelo.

**Atenção:** a aprovação atual do painel propaga a associação para produtos de mesma medida. Não usar aprovação em lote sem conferir cada produto envolvido. O resumo de cada candidata também contém esse aviso.

Na importação inicial foram preservados 10 vínculos antigos divergentes da pesquisa (retirados na correção posterior documentada acima):

- Seis vínculos de produtos 90/90-10 como traseiros para Burgman 125i/Lindy 125. Os manuais consultados registram essa medida na dianteira e 100/90-10 na traseira.
- Quatro vínculos de produtos 140/70-17 para ambos os eixos da CB 300F Twister. O manual consultado de 2025–2026 registra 110/70R17 dianteiro e 150/60R17 traseiro. Não estender a conclusão automaticamente a todos os anos do cadastro antigo.

Fontes e ressalvas completas estão em `scripts/data/catalog-fitment-research-20260906.mjs` e na planilha `outputs/catalogo-pneus-20260906/catalogo-compatibilidade-pneus.xlsx`.

## Operação e testes

O importador `scripts/import-catalog-fitment-research.cjs` exige `--prod` e o destino exato atual. Sem `--commit`, todas as inserções são revertidas. IDs determinísticos e trava transacional impedem repetição do lote; reexecuções não reabrem decisões humanas. O arquivo de ambiente antigo não deve ser usado como destino.

Antes do COMMIT, cria snapshot local de produtos e diário de IDs em `.codex-tmp/backups/`, com verificação SHA-256. Esses arquivos são ignorados pelo Git. O lote aplicado tem relatório com horário `2026-09-06T17-37-37-273Z`. Nenhum segredo foi incluído no código ou nos relatórios.

Validações da importação: seis testes unitários do importador, três testes em Postgres efêmero no Docker, TypeScript, manifesto de migrations, simulação com rollback em produção e conferência somente-leitura depois do COMMIT. A publicação do código não reexecuta o importador nem aprova as candidatas.
