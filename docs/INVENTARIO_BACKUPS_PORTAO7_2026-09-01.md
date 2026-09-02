# Inventário de backups — Portão 7

Data da verificação: 01/09/2026

Este documento registra somente existência, tamanho, data de modificação e
SHA-256. Nenhum backup foi aberto, movido, apagado ou restaurado nesta etapa.

## Resumo

- 11 arquivos localizados;
- 33,20 MB no total;
- 3 dumps com zero byte, que **não são backups válidos**;
- 6 dumps não vazios aguardando prova de restauração;
- 2 arquivos `.tgz` são arquivos históricos do projeto, não dumps do banco.

## Arquivos

| Caminho local | Bytes | Modificado em | SHA-256 |
|---|---:|---|---|
| `_backup-goldens-painel-onda-c-2026-06-11.tgz` | 38.162 | 2026-06-11 10:00:45 | `D2980E683C909D693718135F263AFD109B24B3D45F8D3330E946B49FDB4372C7` |
| `_backup-untracked-limpeza-2026-06-06.tgz` | 13.018.601 | 2026-06-06 01:02:34 | `0AA120C6AD7D35F179F1CB10B955723C2980C01785854BB93024095E24DB11F3` |
| `.codex-tmp/backups/farejador-prod-portao0-post-0212-20260827-084807.dump` | 1.926.935 | 2026-08-27 08:48:24 | `4039B2940EC8337F3598D76FF54BC7A6899C7A73CBCB2745F00F6433A32054FE` |
| `.codex-tmp/backups/farejador-prod-pre-0200-20260822-155942.dump` | 3.540.280 | 2026-08-22 16:02:18 | `4201D8AB2FD3EEAD8B1876A4491BED1D25065CD95591F80D29CCABFD6BB0F8FF` |
| `.codex-tmp/backups/farejador-prod-pre-0205-0206-20260824.dump` | 1.857.296 | 2026-08-24 07:23:25 | `E892B049CBFE4458717C58CDFAA62AFEDB9B60148E9C7ECD7897E08C320DA67E` |
| `output/backups/farejador-prod-pre-0190-20260820-234320.dump` | 0 | 2026-08-20 23:43:55 | **VAZIO** |
| `output/backups/farejador-prod-pre-0190-20260820-234450.dump` | 0 | 2026-08-20 23:44:50 | **VAZIO** |
| `output/backups/farejador-prod-pre-0190-20260820-234753.dump` | 4.953.210 | 2026-08-20 23:50:37 | `B9F8CBEBF6EA5FEA00DFE6745EA234EE7B142514B7A19C14E6B2FE9852C76149` |
| `output/backups/farejador-prod-pre-0194-20260821-091252.dump` | 0 | 2026-08-21 09:12:53 | **VAZIO** |
| `output/backups/farejador-prod-pre-0194-20260821-091320.dump` | 4.994.463 | 2026-08-21 09:15:53 | `0D594E7C96EC796C1CE6E28C94EFA1C7534071136D1A978734FD1E1E6937420A` |
| `output/backups/farejador-prod-pre-0196-20260821203005.dump` | 4.481.418 | 2026-08-21 17:32:45 | `59D3199E5116D6F844D463797E068EB3E8211132AB0089468B34D2BE24A575B2` |

## Interpretação correta

Checksum prova que o arquivo não mudou desde este inventário. Não prova que o
dump está íntegro nem que pode restaurar o sistema. A próxima ação sobre estes
arquivos exige ambiente separado e não deve ser misturada com deploy ou mudança
de migration.

Os três dumps vazios permanecem preservados apenas como evidência da tentativa
falha. Sua exclusão definitiva pode ser feita mais tarde, depois da escolha dos
backups que realmente serão retidos.
