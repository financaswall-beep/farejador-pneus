# Identificação dos anúncios na revisão de Marketing

Branch local `codex/meta-review-identification-20261103`, baseada no main `12b17fea` (PR #148). Sem push ou deploy nesta etapa.

## Problema e entrega

A revisão mostrava somente IDs. A consulta somente leitura em produção confirmou 22 anúncios pendentes/arquivados sem nomes salvos de anúncio ou campanha. Não houve alteração de classificações, anúncios ou financeiro.

O endpoint de revisão passa a enriquecer a apresentação com a leitura de criativos da Meta já existente: nome do anúncio, nome da campanha, título, texto e miniatura. Usa apenas IDs que já estão na lista autorizada e pertencem à conta configurada. A resposta valida também o vínculo com a campanha; anúncios que mudaram de campanha não recebem conteúdo associado ao snapshot antigo.

Os nomes ficam em destaque e os IDs ficam em “Identificadores”, tanto na lista como no formulário. Mostra a situação (arquivado/ativo/pausado) já registrada na coleta. O foco e a rolagem do PR #148 permanecem.

Se a Meta não retornar detalhes, a consulta tenta nomes anteriores do mesmo ambiente/conta no histórico existente. IDs usados como fallback antigo não são apresentados como nomes. Sem nome ou prévia recuperáveis, mostra a indisponibilidade expressamente e mantém o link oficial. A lista continua acessível em caso de falha do provedor.

## Limites preservados

- Só leitura, com as permissões de proprietário já existentes.
- Mesma classificação, fingerprint, justificativa e confirmação manual.
- Nenhum lançamento ou reconciliação provocado pela consulta de nomes.
- Tokens ficam no servidor e fora das URLs; imagens limitadas aos domínios Meta já permitidos pelo leitor.
- Reaproveita o cache existente, com prazo curto e chave separada por conta, versão e credencial.
- Nenhuma migration, variável ou dependência nova. Nenhuma chamada de IA.

## Provas e evidências

- Testes unitários do enriquecimento: conta configurada, troca de campanha, falha do provedor, fallback histórico, imagem insegura, ausência de configuração e ID usado como nome.
- Suíte unitária completa: **565 arquivos e 3.739 testes passaram**.
- Integração em PostgreSQL descartável: **12 testes passaram** nos dois arquivos de identidade e gastos pendentes. O novo caso verifica nomes do histórico, isolamento prod/test e preservação de escopo/financeiro.
- Depois do ajuste final para filtrar o histórico também pela campanha, os **5 testes de identidade** passaram novamente, incluindo um registro mais novo de outra campanha que não pode ser usado como nome.
- Navegador com o HTML/Alpine reais em 1440 e 390 px: nome, campanha e prévia presentes; IDs recolhidos; formulário visível e focado; nenhuma navegação externa ou gravação. Revisão Google e início financeiro preservados.
- Typecheck, fiscal de tamanho e paridade do painel (3.122 propriedades) passaram.
- Resultado final da suíte unitária e capturas em `C:/Farejador agente/.codex-tmp/meta-review-identification-20261103/` (`unit-final.log`, `list-1440.png`, `after-1440.png`, `after-390.png`, `after-result.json`).

**As capturas usam nomes e imagens fictícios.** Não houve consulta autenticada à Meta para recuperar os detalhes reais dos 22 anúncios nesta máquina. A chamada usará a credencial já configurada no servidor após publicar; não é garantido recuperar todos os anúncios antigos. O código não inventa esses dados.

Código das capacidades de leitura conferido no SDK oficial da Meta: https://github.com/meta/facebook-php-business-sdk/blob/main/src/FacebookAds/Object/Fields/AdFields.php e https://github.com/meta/facebook-php-business-sdk/blob/main/src/FacebookAds/Object/Fields/AdCreativeFields.php.

Para publicar: revisar/integrar a branch e fazer o deploy manual no Coolify. Etiqueta do módulo da revisão: `20261103-review-names1`.
