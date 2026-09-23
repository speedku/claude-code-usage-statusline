@echo off
rem Logowanie konta Claude do claude-swap BEZ wylogowywania biezacego konta.
rem
rem /login w zwyklym Claude Code wylogowuje konto, z ktorego wychodzisz, a to
rem uniewaznia kopie jego tokenu trzymana przez cswap ("re-login needed").
rem Ten skrypt loguje w osobnym, pustym katalogu (CLAUDE_CONFIG_DIR), wiec nic
rem sie nie wylogowuje, potem zapisuje logowanie pod wskazanym numerem w cswap
rem i sprzata katalog tymczasowy.
rem
rem Uzycie (w osobnym oknie terminala, nie wewnatrz Claude Code):
rem   claude-add-account.cmd 2
rem Numer = miejsce konta w cswap (cswap list). Nowe konto: nastepny wolny numer.

setlocal
if "%~1"=="" (
    echo Uzycie: claude-add-account.cmd NUMER_KONTA
    echo Numery kont pokazuje: cswap list
    exit /b 1
)

set "CSWAP=%USERPROFILE%\.local\bin\cswap.exe"
set "CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-logowanie-%~1"
if exist "%CLAUDE_CONFIG_DIR%" rmdir /s /q "%CLAUDE_CONFIG_DIR%"
mkdir "%CLAUDE_CONFIG_DIR%"

echo.
echo ==============================================================
echo  Za chwile otworzy sie Claude Code w czystym katalogu.
echo  1. Zaloguj sie na konto, ktore ma byc pod numerem %~1
echo     (jesli nie zapyta sam, wpisz /login).
echo  2. Po zalogowaniu wpisz /exit
echo  NIE uzywaj /logout.
echo ==============================================================
echo.
pause

call claude

"%CSWAP%" add --slot %~1
set "WYNIK=%ERRORLEVEL%"

rem Sama kopia plikow, bez /logout, wiec token zostaje wazny w cswap.
rmdir /s /q "%CLAUDE_CONFIG_DIR%"

echo.
"%CSWAP%" list
exit /b %WYNIK%
