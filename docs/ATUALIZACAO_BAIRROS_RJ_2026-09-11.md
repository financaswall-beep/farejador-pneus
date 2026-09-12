# Atualização do dicionário regional RJ — 11/09/2026

Status: **aplicado e validado em produção**.

Escopo autorizado: completar os nomes de bairros/localidades dos 15 municípios já cadastrados. O proprietário orientou usar São Gonçalo como preferência operacional para “Rio do Ouro”, mantendo o pertencimento também a Niterói.

## Resultado

- Cadastro anterior: 624 registros. Cadastro após a carga: **1.038 registros**.
- **414 nomes novos:** 368 ausências da pesquisa e 46 nomes/recortes mantidos separados de formas parecidas já existentes. São registros do dicionário, não uma contagem de bairros legalmente distintos.
- **19 aliases:** 18 variações de grafia/artigos/numerais e a grafia “Guia de Pacopaíba” do plano de Magé, ligada à entrada “Guia de Pacobaíba”.
- Nenhum ID ou nome anterior foi removido ou renomeado. Aliases existentes foram preservados. A carga regional altera somente `commerce.geo_resolutions` de `prod`.

| Município | Nomes adicionados | Total no dicionário |
|---|---:|---:|
| Araruama | 39 | 65 |
| Belford Roxo | 11 | 151 |
| Duque de Caxias | 24 | 53 |
| Itaboraí | 64 | 73 |
| Magé | 54 | 81 |
| Maricá | 28 | 56 |
| Nilópolis | 7 | 18 |
| Niterói | 4 | 55 |
| Nova Iguaçu | 32 | 69 |
| Rio Bonito | 48 | 49 |
| Rio de Janeiro | 5 | 167 |
| Saquarema | 36 | 44 |
| São Gonçalo | 52 | 116 |
| São João de Meriti | 7 | 20 |
| Tanguá | 3 | 21 |

## Rio do Ouro

A migration `0228_neighborhood_city_priority.sql` adiciona uma prioridade operacional genérica e preserva a assinatura de `commerce.resolve_neighborhood`. A carga regional atribui prioridade 100 somente a Rio do Ouro/São Gonçalo; as demais entradas permanecem com zero.

- Sem município, a consulta retorna São Gonçalo primeiro, inclusive para o consumidor existente que usa `LIMIT 1`.
- Com “Niterói” informado, o filtro retorna Niterói. A preferência não substitui cidade explícita, coordenadas ou endereço.
- As entradas de Magé e Rio Bonito também permanecem consultáveis com o município correspondente.
- A prioridade não muda frete, estoque, cobertura de parceiros nem dados históricos de conversas.

**Limite da carga:** a função continua devolvendo todos os candidatos. A carga regional, sozinha, não corrige a escolha automática do primeiro resultado pelo bot em bairros homônimos, como Flamengo/Centro.

### Confirmação de município no bot — implementação local

A correção adicional em `src/atendente-v2/neighborhood-resolution.ts` e `tool-location.ts` interrompe as ferramentas comerciais antes de consultar estoque, cotar frete ou criar pedidos quando o bairro tem mais de uma cidade possível. Nomes exatos e aliases são considerados juntos; a busca aproximada não corta candidatos de outras cidades. A dúvida retorna `precisa_municipio=true`, sem registrar falta de estoque.

O prompt `agent_v2_neighborhood_city_confirmation_2026-09-11` orienta perguntar somente a cidade e repetir a consulta preservando o pneu e o bairro. Cidade já informada, pino resolvido e contexto de localização válido da mesma conversa evitam a pergunta. Rio do Ouro mantém a preferência por São Gonçalo, respeitando município explícito ou pino resolvido.

Validação: 463 testes unitários do atendente e 12 testes de integração com PostgreSQL passaram; TypeScript sem erros. A correção entra em produção após o deploy do código. Usa a migration 0228 já aplicada; não acrescenta migration nem variável de ambiente.

## Como os 64 casos de revisão foram tratados

As 18 variações ortográficas abaixo foram adicionadas como aliases. Nos outros 46 casos, sem prova de equivalência territorial, foi mantido o nome documentado em uma entrada separada. Não se fundiram automaticamente recortes II/III, nomes com prefixo Parque/Jardim ou distrito e bairro. Isso pode manter referências sobrepostas no dicionário, mas preserva os vínculos operacionais anteriores.

| Município | Nome na fonte | Tratamento |
|---|---|---|
| Belford Roxo | Xavantes | Entrada separada: Xavantes |
| Belford Roxo | Redentor | Entrada separada: Redentor |
| Belford Roxo | das Graças | Entrada separada: das Graças |
| Belford Roxo | Pauline | Entrada separada: Pauline |
| Belford Roxo | Glaucia | Entrada separada: Glaucia |
| Belford Roxo | São José | Entrada separada: São José |
| Belford Roxo | Maringá | Entrada separada: Maringá |
| Belford Roxo | São Vicente | Entrada separada: São Vicente |
| Duque de Caxias | Vinte e Cinco de Agosto | Entrada separada: Vinte e Cinco de Agosto |
| Duque de Caxias | Cidade Parque Paulista | Entrada separada: Cidade Parque Paulista |
| Itaboraí | Visconde | Entrada separada: Visconde |
| Nilópolis | Manoel Reis | Alias de Manuel Reis |
| Nilópolis | da Mina | Entrada separada: da Mina |
| Nilópolis | Paiol | Entrada separada: Paiol |
| Nilópolis | Cabuís II | Entrada separada: Cabuís II |
| Nilópolis | Manoel Reis II | Entrada separada: Manoel Reis II |
| Niterói | Cachoeira | Alias de Cachoeiras |
| Niterói | Vital Brasil | Alias de Vital Brazil |
| Nova Iguaçu | da Posse | Alias de Posse |
| Nova Iguaçu | da Cerâmica | Alias de Cerâmica |
| Nova Iguaçu | Ambaí | Entrada separada: Ambaí |
| Nova Iguaçu | da Palhada | Alias de Palhada |
| Rio de Janeiro | Freguesia (Ilha do Governador) | Entrada separada: Freguesia (Ilha do Governador) |
| São Gonçalo | Luiz Caçador | Alias de Luís Caçador |
| São Gonçalo | Porto da Rosa | Alias de Porto do Rosa |
| São Gonçalo | Amendoeira | Entrada separada: Amendoeira |
| São Gonçalo | Anaia Pequeno | Entrada separada: Anaia Pequeno |
| São Gonçalo | Tribobó II | Entrada separada: Tribobó II |
| São Gonçalo | Vila Candosa | Alias de Vila Candoza |
| São Gonçalo | Lagoinha II | Entrada separada: Lagoinha II |
| São Gonçalo | Largo da Idéia II | Entrada separada: Largo da Idéia II |
| São Gonçalo | Monjolo | Alias de Monjolos |
| São Gonçalo | Pacheco II | Entrada separada: Pacheco II |
| São Gonçalo | Raul Veiga II | Entrada separada: Raul Veiga II |
| São Gonçalo | Sacramento II | Entrada separada: Sacramento II |
| São Gonçalo | Brasilândia II | Entrada separada: Brasilândia II |
| São Gonçalo | Parada Quarenta | Alias de Parada 40 |
| São Gonçalo | Porto da Madame | Alias de Porto da Madama |
| São Gonçalo | Zé Garoto II | Entrada separada: Zé Garoto II |
| São Gonçalo | Barro Vermelho II | Entrada separada: Barro Vermelho II |
| São Gonçalo | Covanca II | Entrada separada: Covanca II |
| São Gonçalo | Engenho Pequeno II | Entrada separada: Engenho Pequeno II |
| São Gonçalo | Lindo Parque II | Entrada separada: Lindo Parque II |
| São Gonçalo | Maria Paula II | Entrada separada: Maria Paula II |
| São Gonçalo | Neves II | Entrada separada: Neves II |
| São Gonçalo | Pita II | Entrada separada: Pita II |
| São Gonçalo | Santa Catarina II | Entrada separada: Santa Catarina II |
| São Gonçalo | Tribobó III | Entrada separada: Tribobó III |
| São Gonçalo | Apolo III | Entrada separada: Apolo III |
| Saquarema | Porto da Roça I | Entrada separada: Porto da Roça I |
| Saquarema | Porto da Roça II | Entrada separada: Porto da Roça II |
| Tanguá | Mangueiras | Entrada separada: Mangueiras |
| Tanguá | Núcleo Urbano de Posse dos Coutinhos | Entrada separada: Núcleo Urbano de Posse dos Coutinhos |
| Maricá | Jardim Atlântico Oeste | Entrada separada: Jardim Atlântico Oeste |
| Araruama | Centro de Praia Seca | Entrada separada: Centro de Praia Seca |
| Araruama | Hawaii | Alias de Hawai |
| Araruama | Nossa Senhora de Nazareth | Alias de Nossa Senhora Nazareth |
| Araruama | Paraty | Alias de Parati |
| Araruama | Praça da Bandeira | Alias de Praça Bandeira |
| Araruama | XV de Novembro | Alias de 15 De Novembro |
| Magé | Guia de Pacopaíba | Entrada separada: Guia de Pacobaíba |
| Magé | Anil | Entrada separada: Anil |
| Magé | Sayonara | Entrada separada: Sayonara |
| Rio Bonito | Basílio | Alias de Bazílio |

## Fontes

- [IBGE — Malha de bairros do Censo 2022](https://ftp.ibge.gov.br/Censos/Censo_Demografico_2022/Agregados_por_Setores_Censitarios/malha_com_atributos/bairros/shp/UF/RJ/) — Referência 2022; arquivo publicado em 13/11/2024.
- [Prefeitura de Maricá — Sistema Municipal de Informações, camada Bairros](https://sinfor.marica.rj.gov.br/server/rest/services/Limites_Administrativos/FeatureServer/0) — Serviço consultado em 11/09/2026; 49 feições retornadas.
- [Câmara de Araruama — Lei 1.606/2010, art. 1º](https://cmararuama.rj.gov.br/images/2022/leis/1606.pdf) — 22/11/2010; lista de 59 nomes conferida visualmente na página 1.
- [Prefeitura de Magé — Plano Municipal de Saúde 2022–2025](https://transparencia.mage.rj.gov.br/webrun/tmp/PortalServices/PMS20222025.pdf) — Divisão distrital, páginas 9 e 10 do PDF, conferidas visualmente.
- [Prefeitura de Rio Bonito — Mapa de Abairramento](https://riobonito.rj.gov.br/wp-content/mapa/index.html) — Serviço consultado em 11/09/2026; 49 camadas de bairros.
- [Prefeitura de Rio Bonito — atualização de bairros e CEPs](https://riobonito.rj.gov.br/bairros-de-rio-bonito-ganha-novos-codigos-de-enderecamento-postal/) — 31/03/2026; confirma 49 bairros no novo endereçamento.
- [Prefeitura de Maricá — JOM 207, art. 8º](https://www.marica.rj.gov.br/wp-content/uploads/2022/08/jom_207.pdf) — 28/06/2010, página 8: Jardim Interlagos; diferença em relação à camada atual.
- [Prefeitura de Maricá — ocorrência em Jardim Interlagos](https://www.marica.rj.gov.br/noticia/secretaria-de-seguranca-cidada-captura-cobra-em-jardim-interlagos/) — 20/02/2025; confirma o uso atual do nome.
- [Câmara de Magé — História](https://camaramage.rj.gov.br/cidade/historia/) e [Prefeitura de Magé — Unidades de Ensino](https://mage.rj.gov.br/unidades-ensino/): conferência da grafia Guia de Pacobaíba, distrito, sem fundi-lo à entrada Praia de Mauá.

A pesquisa usa fontes com datas e critérios diferentes. Não certifica completude de todos os bairros atuais nem transforma sedes distritais e localidades em bairros legais. No mapa de Rio Bonito, “Nova Cidade” e “Cidade nova” são camadas distintas; ambos os nomes foram preservados. Em Maricá, Jardim Interlagos tem evidência documental e uso municipal recente, apesar de não vir na camada de 49 feições consultada.

## Reprodução e validação

- Estrutura e resolução: `db/migrations/0228_neighborhood_city_priority.sql`, registrada no manifesto e no ledger de aplicações.
- Dados regionais: bloco `BEGIN GEO RJ 2026-09` até `END GEO RJ 2026-09` em `db/seeds/regiao-rio-de-janeiro.sql`. O bloco roda após a migration 0228 e pode ser reaplicado sem duplicar registros ou alterar timestamps sem necessidade.
- A região continua sendo opcional no instalador. Os dados não foram incluídos em migrations globais nem em outras regiões.
- Testes: sete verificações de integração em PostgreSQL isolado; duas verificações do manifesto; TypeScript sem erros.
- Validação no banco de destino: ensaio com rollback; comparação dos registros anteriores; conferência dos 414 nomes e 19 aliases; prioridade e município explícito; reaplicação idempotente.
- Cópia anterior, resultado do ensaio, resultado da aplicação e cadastro posterior: `artifacts/pesquisa-bairros-2026-09-11/`. Esses arquivos locais não são requisito para instalar o projeto.

A consulta existente passa a usar a prioridade assim que a migration e a carga são aplicadas. Não exige nova variável de ambiente nem deploy do aplicativo.
