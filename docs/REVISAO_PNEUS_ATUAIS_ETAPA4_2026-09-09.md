# Revisão dos pneus atuais — etapa 4

Data da aplicação: 09/09/2026.

## Resultado

- 49 produtos ativos revisados no catálogo novo.
- 4 fichas com modelo/desenho exato confirmadas em fonte oficial.
- 45 fichas mantidas pendentes de identificação física.
- 4 alterações aplicadas em uma única transação com auditoria.
- Segunda execução em simulação: zero alterações, confirmando idempotência.
- Migration: não necessária.

## Fichas confirmadas

| Produto | Modelo/desenho | Posição | Carga | Velocidade | Fonte |
|---|---|---:|---:|---:|---|
| Levorin 110/70-13 | Matrix Scooter | Dianteiro | 48 | P | [Levorin](https://levorin.com.br/pneu-moto/matrix-scooter/) |
| Maggion 110/70-13 | Sportíssimo II | Dianteiro | 48 | P | [Maggion](https://maggion.com.br/pneus/SportissimoII) |
| Michelin 110/70-13 | City Grip 2 | Dianteiro | 48 | S | [Michelin Brasil](https://www.michelin.com.br/motorbike/browse-tyres/by-dimension/110/70/13/48/S) |
| Pirelli 180/55-17 | Diablo Rosso | Traseiro | 73 | W | [Catálogo Pirelli 2025](https://tyre24.pirelli.com/moto/assets/pirelli/pdf/global/PIRELLI_Product_Range_2025.pdf) |

## Critério das pendências

Os demais cadastros informam apenas marca e medida. Isso não identifica o pneu
físico, especialmente em produto usado: uma fabricante pode comercializar mais
de um desenho na mesma medida, além de linhas antigas já fora do catálogo
atual. Por isso, nenhuma posição, carga ou velocidade foi inferida.

Para concluir uma pendência, o operador precisa ler no pneu o nome do
modelo/desenho e, quando legíveis, os índices ao lado da medida. Depois disso,
usa a ficha lateral do Catálogo para registrar os dados. O filtro “Posição
pendente” concentra os produtos que ainda precisam dessa conferência.

O inventário e as fontes usados na operação estão versionados em
`scripts/data/catalog-tire-spec-review-20260909.cjs`. A aplicação reproduzível e
auditada está em `scripts/apply-catalog-tire-spec-review.cjs`.
