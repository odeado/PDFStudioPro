@echo off
title PDF Studio Pro - Iniciando...
echo.
echo  ================================================
echo   PDF Studio Pro - Iniciando servidor local...
echo  ================================================
echo.

REM Try Python 3 first (most common)
python --version >nul 2>&1
if %errorlevel% == 0 (
    echo  [OK] Python encontrado. Iniciando servidor en puerto 8080...
    echo.
    echo  Abre tu navegador en: http://localhost:8080
    echo  (Se abrira automaticamente en unos segundos)
    echo.
    echo  Para cerrar el servidor: presiona Ctrl+C
    echo.
    start "" http://localhost:8080
    python -m http.server 8080
    goto end
)

REM Try Python 3 explicit
python3 --version >nul 2>&1
if %errorlevel% == 0 (
    echo  [OK] Python 3 encontrado. Iniciando servidor...
    start "" http://localhost:8080
    python3 -m http.server 8080
    goto end
)

REM Try Node.js with npx serve
node --version >nul 2>&1
if %errorlevel% == 0 (
    echo  [OK] Node.js encontrado. Iniciando con npx serve...
    start "" http://localhost:3000
    npx -y serve . -p 3000
    goto end
)

REM No server available - open directly (some features may be limited)
echo  [!] Python y Node.js no encontrados.
echo  [!] Abriendo directamente en el navegador...
echo  [!] Nota: Algunas funciones pueden no funcionar sin servidor.
echo.
start "" index.html

:end
pause
