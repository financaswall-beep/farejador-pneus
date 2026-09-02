# Manifesto de limpeza do repositório — 2026-08-27

## Objetivo

Separar o que pertence ao Farejador, o que é material operacional ou histórico e o que é sobra local regenerável. Este documento não autoriza apagar dados de produção, migrations, backups ou arquivos de ambiente.

## Veredito curto

O núcleo do sistema está identificável e não precisa ser refeito. A pasta está desorganizada principalmente por cópias temporárias, mockups, relatórios locais, scripts avulsos e backups misturados ao repositório.

A limpeza deve ser feita em camadas. Não se deve apagar a pasta `parceiro/`, migrations, scripts rastreados, dumps ou arquivos `.env*` no mesmo lote.

## Início do Portão 7 — 2026-09-01

- 1.653 arquivos rastreados pelo Git;
- 129 entradas locais fora do estado limpo;
- 90 scripts locais e 130 scripts oficiais;
- 81 previews, outputs ou artefatos visuais locais;
- 11 arquivos `.dump`/`.tgz`, somando 33,20 MB, preservados;
- 2 worktrees temporários limpos, somando 139,16 MB, com commits alcançáveis;
- `.dockerignore` validado em build completo, com contexto de 6,97 MB.

O primeiro lote autorizado foi executado em 01/09/2026. Os worktrees
`tmp/fix-drawer/` e `tmp/deploy-main/` foram removidos com
`git worktree remove`, sem exclusão direta de pastas, liberando 139,16 MB. O
build e os 1.493 testes unitários, distribuídos em 302 arquivos, passaram depois
da limpeza. O `dist/` local continua regenerável e será tratado separadamente.

A triagem do próximo lote separou claramente os materiais restantes:

- `tmp/` contém aproximadamente 5,85 MB de mockups e marcas, cerca de 1,52 MB
  de logs de servidores locais e vários resultados JSON de auditoria;
- `.codex-tmp/` contém 7,00 MB de backups, que permanecem intocados;
- `output/` contém 13,76 MB de backups e cerca de 36 MB de conceitos visuais e
  documentos, que devem ser arquivados antes de sair da pasta;
- `tmp/imagegen/` e `tmp/pdfs/` estão vazias;
- os 13 mocks/previews locais de `painel/public/` não possuem referência em
  nenhum arquivo rastreado. Eles foram retirados do runtime e preservados, com
  hashes, em `output/archive/painel-public-mockups-2026-09-01/`.

Nenhum item desta segunda triagem foi apagado.

As pastas locais `.codex-tmp/` e `output/` passaram a ser ignoradas pelo Git.
Elas continuam existentes no disco e excluídas do contexto Docker; a mudança
somente impede que backups, evidências e arquivos gerados sejam adicionados por
engano a futuros commits.

## O que forma o sistema publicado

O `Dockerfile` compila `src/` e, na imagem final, leva somente:

- `dist/` — servidor TypeScript compilado;
- `segments/` — regras e arquivos de segmento usados em execução;
- `painel/` — painel da Matriz e a nova interface compartilhada;
- `parceiro/` — interface legada ainda servida durante a transição;
- dependências de produção definidas em `package.json` e `package-lock.json`.

Também pertencem ao sistema, embora não sejam copiados para a imagem final:

- `db/migrations/` — história instalável do banco;
- `tests/` — proteção de regressão;
- `scripts/` rastreados — instalação, auditoria, provas e operação;
- `styles/`, configurações Tailwind e TypeScript — entrada do build;
- `.github/workflows/ci.yml` — validação automática;
- documentação canônica e runbooks de operação.

## Inventário encontrado

| Área | Situação | Ação |
|---|---|---|
| `src/` (442 arquivos rastreados) | Código do servidor | Manter |
| `db/` (219 arquivos rastreados) | Banco e migrations | Manter integralmente |
| `painel/` (191 rastreados) | Interface ativa | Manter; revisar apenas 13 mockups não rastreados |
| `parceiro/` (65 rastreados) | Legado ainda ativo | Não apagar até concluir migração e canário |
| `tests/` (376 rastreados) | Qualidade e segurança | Manter |
| `scripts/` (130 rastreados) | Ferramentas oficiais | Manter; consolidar depois |
| `docs/` (198 rastreados) | Histórico e operação | Manter; arquivar handoffs antigos em uma pasta própria |
| `segments/`, `styles/`, `SECOES/` | Configuração e referência | Manter |
| `dist/` — 4,32 MB | Build gerado | Pode apagar localmente; `npm run build` recria |
| `node_modules/` — 152,45 MB | Dependências instaladas | Não é código; pode reinstalar com `npm ci` |
| `tmp/` — 150,74 MB | Cópias, logs e resultados temporários | Limpar por lote, preservando somente evidências escolhidas |
| `output/` — 49,95 MB | Imagens, conceitos, PDFs e dumps | Separar mockups de backups |
| `.codex-tmp/` — 5,18 MB | Logs e backups locais | Preservar dumps; logs podem sair |
| `.kilo/` — 220,24 MB | Ferramenta local e dependências | Não pertence ao Farejador; limpeza opcional da ferramenta |
| `.kilocode/` — 48,49 MB | Ferramenta local; uma regra é rastreada | Manter `rules/base.md`; dependências locais são regeneráveis |

## Lixo comprovado ou regenerável

Estes alvos não são usados pelo runtime nem estão rastreados pelo Git:

1. `tmp/fix-drawer/` — 131,00 MB. Cópia completa antiga do repositório removida no Lote 1.
2. `tmp/deploy-main/` — 8,16 MB. Cópia antiga do repositório e do build removida no Lote 1.
3. Logs antigos dentro de `tmp/`, `.codex-tmp/` e `output/`.
4. `dist/` — recriado pelo build.
5. Pastas vazias de preview dentro de `tmp/`.

Os dois clones temporários já liberaram 139,16 MB. `dist/` e logs permanecem
fora deste lote para não misturar alvos nem apagar evidências sem classificação.

Opcionalmente, remover e reinstalar `node_modules/`, `.kilo/node_modules/` e `.kilocode/node_modules/` pode liberar mais de 420 MB, mas isso interrompe temporariamente as ferramentas locais até a reinstalação.

## Material que pode sair da raiz, mas deve ser arquivado primeiro

- `output/` sem as subpastas de backup: aproximadamente 36 MB de mockups, conceitos, imagens e documentos gerados;
- 13 HTML/SVG de mockup em `painel/public/`, sem referência em arquivos rastreados e sem carregamento pela aplicação;
- `proposta-layout-2026-06/`;
- `dashboard.html` antigo, citado somente em documentação;
- `assets/` da raiz: fontes do mapa e artefatos de geração; o runtime usa os arquivos já incorporados em `painel/public/`;
- 20 documentos não rastreados, principalmente auditorias e handoffs;
- 90 scripts não rastreados.

Esses itens devem ir para um arquivo histórico fora da raiz ou para uma pasta de arquivo com índice. Apagar diretamente faria perder contexto de auditoria e ferramentas que ainda são citadas por documentos.

## Scripts não rastreados

Foram encontrados 90 scripts fora do Git:

- 31 scripts capazes de alterar dados, aplicar migrations, criar contas, semear ou limpar ambientes;
- 51 scripts de leitura, diagnóstico, auditoria, smoke ou prova;
- 8 geradores, previews ou utilitários diversos.

Vinte e nove desses scripts ainda são citados por arquivos rastreados. Portanto, `scripts/` não pode ser limpo por nome ou data. A consolidação correta é:

1. escolher os auditores e instaladores canônicos;
2. versionar os que continuam oficiais;
3. colocar proteção explícita de ambiente nos scripts de mutação;
4. arquivar ou remover os aplicadores antigos de migrations já absorvidas pelo instalador;
5. corrigir documentos que apontem para scripts eliminados.

## Backups e ambientes: não apagar

Foram encontrados aproximadamente 31 MB de backups distribuídos entre:

- `output/backups/`;
- `.codex-tmp/backups/`;
- `_backup-*.tgz` na raiz.

Eles não devem permanecer misturados ao build, mas também não devem ser apagados antes de:

1. gerar checksum;
2. identificar banco, data e migration de cada dump;
3. testar ao menos o backup mais recente em outro banco;
4. mover para armazenamento de backup fora do repositório;
5. definir retenção, por exemplo: último pré-deploy, último semanal e último mensal.

Os arquivos `.env`, `.env.codex`, `.env.novo`, `.env.pooler`, `.env.preview` e variantes não são lixo comum. Eles contêm configuração sensível. A consolidação deve mapear primeiro qual ambiente usa cada arquivo, preservar uma cópia segura fora do repositório e manter no Git somente `.env.example` sem segredos.

## Correção preventiva já aplicada

O `.dockerignore` foi endurecido para impedir que backups, dumps, mockups, documentos, testes, scripts locais e artefatos de agentes sejam enviados ao servidor durante o build.

Antes, esses itens não entravam na imagem final, mas ainda podiam viajar no contexto do Docker e ficar numa camada intermediária do builder. A correção reduz tempo de upload, tamanho do contexto e risco de exposição. Ela não altera o comportamento do Farejador em execução.

## O que não deve ser chamado de lixo agora

- `parceiro/`: ainda existe rota e interface legada em uso durante a migração;
- `db/migrations/`: migrations antigas formam a receita para instalar um banco novo;
- `tests/`: são a rede de proteção financeira, de estoque e de permissões;
- `segments/`: são dados de execução do motor;
- scripts e docs rastreados: podem ser reorganizados, mas não removidos em massa;
- dumps e arquivos de ambiente: são sensíveis e exigem processo próprio.

## Plano seguro de execução

### Lote 1 — limpeza sem risco funcional

- [x] remover os dois clones de `tmp/` pelo Git;
- [x] rodar build após a remoção;
- [x] rodar a suíte unitária completa: 1.493 testes em 302 arquivos;
- [ ] classificar logs e pastas vazias de preview antes da remoção;
- [ ] tratar o `dist/` regenerável em lote separado.

### Lote 2 — arquivo visual e documental

- [x] retirar os 13 mocks/previews sem referência de `painel/public/`;
- [x] preservar os arquivos fora do runtime, sem exclusão definitiva;
- [x] manter índice com data, tamanho e SHA-256;
- [ ] comparar e classificar os demais conceitos visuais de `output/`;
- [ ] classificar `proposta-layout-2026-06/`, `dashboard.html` e `assets/`.

### Lote 3 — scripts

- [x] identificar os scripts locais com capacidade de gravação;
- [x] isolar 23 utilitários pontuais sem referência rastreada, preservando hash;
- [x] manter os 29 scripts citados por documentos em seus caminhos atuais;
- [ ] revisar os 67 scripts locais restantes;
- [ ] proteger ou oficializar os 14 scripts de gravação ainda citados;
- [ ] manter somente instaladores e auditores canônicos;
- [ ] corrigir referências documentais somente depois da escolha dos canônicos.

### Lote 4 — backups e segredos

- [x] inventariar os 11 arquivos e gerar SHA-256;
- [x] identificar 3 dumps vazios que não são backups válidos;
- [ ] verificar restauração dos dumps não vazios;
- [ ] mover dumps válidos para cofre de backup;
- consolidar arquivos de ambiente;
- rotacionar segredos expostos e invalidar os antigos.

### Lote 5 — legado do parceiro

- [x] auditar referências e rotas atuais;
- [x] confirmar que `parceiro/public/` ainda é servido por rotas ativas;
- [ ] fazer todas as rotas visuais do parceiro apontarem para o painel compartilhado;
- provar login, estoque, vendas, retiradas, financeiro e permissões em web e `/operacao`;
- executar canário real;
- retirar a interface antiga em uma publicação separada, com rollback disponível.

**Decisão:** a remoção física está bloqueada. `src/parceiro/route.ts` ainda serve
`index.html`, JavaScript, CSS, assets, vendor e service worker de
`parceiro/public/`. O backend e as APIs em `src/parceiro/` também permanecem
ativos e não devem ser confundidos com o legado visual.

## Critério para considerar a limpeza concluída

- `git status` contém apenas mudanças intencionais;
- build Docker não recebe dumps, `.env`, mockups ou arquivos de agente;
- instalação do zero continua usando todas as migrations;
- build, testes e provas passam após apagar `dist/`;
- backup recente restaura em banco separado;
- nenhum documento canônico aponta para script inexistente;
- a remoção do legado do parceiro ocorre somente depois do canário.
