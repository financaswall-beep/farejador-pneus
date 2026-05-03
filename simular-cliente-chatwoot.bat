@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Simulador Cliente Chatwoot - Farejador

cd /d "%~dp0"

set "CHATWOOT_USE_PRIVATE_API=false"
if "%CHATWOOT_PUBLIC_BASE_URL%"=="" set "CHATWOOT_PUBLIC_BASE_URL=http://localhost:3000"
if "%CHATWOOT_INBOX_IDENTIFIER%"=="" set "CHATWOOT_INBOX_IDENTIFIER=replace-with-inbox-identifier"
if "%CHATWOOT_ACCOUNT_ID%"=="" set "CHATWOOT_ACCOUNT_ID=1"
if "%CHATWOOT_INBOX_ID%"=="" set "CHATWOOT_INBOX_ID=1"

:menu
cls
echo ============================================================
echo  Simulador Cliente Chatwoot - Farejador
echo ============================================================
echo.
echo  1 - Criar NOVA conversa com telefone fake
echo  2 - Entrar em conversa EXISTENTE
echo  3 - Configurar Chatwoot nesta janela
echo  4 - Sair
echo.
set /p OPCAO="Escolha uma opcao: "

if "%OPCAO%"=="1" goto nova
if "%OPCAO%"=="2" goto existente
if "%OPCAO%"=="3" goto config
if "%OPCAO%"=="4" goto fim

echo.
echo Opcao invalida.
pause
goto menu

:config
cls
echo ============================================================
echo  Configurar Chatwoot nesta janela
echo ============================================================
echo.
echo URL publica atual: !CHATWOOT_PUBLIC_BASE_URL!
set /p BASE="URL publica Chatwoot [Enter para manter]: "
if not "%BASE%"=="" set "CHATWOOT_PUBLIC_BASE_URL=%BASE%"

echo.
echo Inbox identifier atual: !CHATWOOT_INBOX_IDENTIFIER!
set /p IDENTIFIER="Inbox identifier [Enter para manter]: "
if not "%IDENTIFIER%"=="" set "CHATWOOT_INBOX_IDENTIFIER=%IDENTIFIER%"

echo.
echo Account ID atual: !CHATWOOT_ACCOUNT_ID!
set /p ACCOUNT="Account ID [Enter para manter]: "
if not "%ACCOUNT%"=="" set "CHATWOOT_ACCOUNT_ID=%ACCOUNT%"

echo.
echo Inbox ID atual: !CHATWOOT_INBOX_ID!
set /p INBOX="Inbox ID [Enter para manter]: "
if not "%INBOX%"=="" set "CHATWOOT_INBOX_ID=%INBOX%"

echo.
echo Token de usuario Chatwoot: opcional.
echo Para criar/falar como cliente, o simulador usa a API publica da inbox.
echo Se voce preencher token, ele usa a API privada.
set /p TOKEN="CHATWOOT_API_TOKEN [Enter para nao usar]: "
if not "%TOKEN%"=="" (
  set "CHATWOOT_API_TOKEN=%TOKEN%"
  set "CHATWOOT_USE_PRIVATE_API=true"
)

echo.
echo Configuracao carregada nesta janela. Nada foi salvo em arquivo.
pause
goto menu

:nova
cls
echo ============================================================
echo  Nova conversa
echo ============================================================
echo.
echo Usando Chatwoot: !CHATWOOT_PUBLIC_BASE_URL!
echo Usando inbox publica: !CHATWOOT_INBOX_IDENTIFIER!
echo Usando Inbox ID interno: !CHATWOOT_INBOX_ID!
echo Se precisar trocar, volte e use a opcao 3.
echo.

set "NOME="
set "TELEFONE="
set /p NOME="Nome do cliente [Enter para gerar]: "
set /p TELEFONE="Telefone com DDI [Enter para gerar]: "

set "ARGS="
if not "%NOME%"=="" set "ARGS=!ARGS! --name="%NOME%""
if not "%TELEFONE%"=="" set "ARGS=!ARGS! --phone="%TELEFONE%""

echo.
echo Abrindo simulador...
echo Digite /sair dentro do simulador para voltar ao menu.
echo.
node --env-file=.env scripts\chatwoot-client-sim.cjs !ARGS!
echo.
pause
goto menu

:existente
cls
echo ============================================================
echo  Conversa existente
echo ============================================================
echo.
echo Exemplo: se a URL for /app/accounts/1/conversations/123,
echo o ID da conversa e 123.
echo.
echo Sem token privado, o Chatwoot tambem precisa do source_id do contato.
echo Se voce nao souber, use a opcao 1 para criar uma conversa nova.
echo.
set /p CONVERSA="ID da conversa Chatwoot: "
if "%CONVERSA%"=="" (
  echo.
  echo Voce precisa informar o ID da conversa.
  pause
  goto menu
)

echo.
echo Usando Inbox ID: !CHATWOOT_INBOX_ID!
echo Se precisar trocar, volte e use a opcao 3.

set "CONTACT_SOURCE="
if not defined CHATWOOT_API_TOKEN (
  echo.
  set /p CONTACT_SOURCE="source_id do contato [Enter se estiver usando token privado]: "
)

echo.
echo Abrindo simulador na conversa %CONVERSA%...
echo Digite /sair dentro do simulador para voltar ao menu.
echo.
if "%CONTACT_SOURCE%"=="" (
  node --env-file=.env scripts\chatwoot-client-sim.cjs --conversation=%CONVERSA%
) else (
  node --env-file=.env scripts\chatwoot-client-sim.cjs --conversation=%CONVERSA% --contact-source=%CONTACT_SOURCE%
)
echo.
pause
goto menu

:fim
endlocal
