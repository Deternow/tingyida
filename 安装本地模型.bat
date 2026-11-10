@echo off
chcp 936 >nul
title 本地做题模型安装器（Ollama + Qwen）
cd /d "%~dp0"

set "PROJECT_DIR=%~dp0"
set "QWEN_DIR=%PROJECT_DIR%models\qwen"
set "QWEN_MODEL=qwen3.5:9b"
set "OLLAMA_EXE="
set "OLLAMA_PID="
set "OLLAMA_READY="
set "STARTING_OLLAMA="
set "USING_EXISTING="

echo ============================================
echo   本地做题模型安装器
echo   1. 检查并安装 Ollama
echo   2. 检查并下载 qwen3.5:9b
echo   3. 把 Ollama 绑定到 models\qwen
echo ============================================
echo   只有在想用本地模型离线作答时才需要运行本文件；
echo   只使用云端 API 的话不用安装。
echo.

rem ---------- 第 1 步：检查 / 安装 Ollama ----------
call :FIND_OLLAMA
if defined OLLAMA_EXE goto :OLLAMA_OK

echo [1/3] 未检测到 Ollama，开始安装...
echo.
where.exe winget.exe >nul 2>nul
if errorlevel 1 goto :INSTALL_OFFICIAL

echo       正在通过 winget 安装 Ollama，请稍候...
winget install --id Ollama.Ollama --exact --accept-package-agreements --accept-source-agreements
call :FIND_OLLAMA
if defined OLLAMA_EXE goto :OLLAMA_OK

:INSTALL_OFFICIAL
echo.
echo       winget 不可用或安装失败，改用 Ollama 官方安装脚本...
echo.
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; irm 'https://ollama.com/install.ps1' | iex"
call :FIND_OLLAMA
if not defined OLLAMA_EXE goto :INSTALL_FAILED

:OLLAMA_OK
echo [1/3] Ollama 已就绪：%OLLAMA_EXE%
echo.

rem ---------- 第 2 步：检查 / 下载模型 ----------
echo [2/3] 检查指定位置是否已有 %QWEN_MODEL%...
if exist "%QWEN_DIR%\manifests\registry.ollama.ai\library\qwen3.5\9b" goto :MODEL_OK
if exist "%QWEN_DIR%\manifests-v2\ollama.com\library\qwen3.5\9b" goto :MODEL_OK
if exist "%QWEN_DIR%\manifests\registry.ollama.ai\library\qwen3.5\9b\meta.json" goto :MODEL_OK

echo        指定目录没有该模型，需要下载约 6.6 GB 到：
echo        %QWEN_DIR%
echo.
set "ANS=Y"
set /p "ANS=        现在下载吗？(Y/N，直接回车=Y)："
if /i not "%ANS%"=="Y" goto :SKIP_DOWNLOAD

if not exist "%QWEN_DIR%" mkdir "%QWEN_DIR%"
if errorlevel 1 goto :MKDIR_FAILED

rem 用独立端口和模型目录下载，不影响已经在跑的 Ollama
set "OLLAMA_HOST=127.0.0.1:11435"
set "OLLAMA_MODELS=%QWEN_DIR%"

netstat -ano | findstr /R /C:":11435 .*LISTENING" >nul
if not errorlevel 1 goto :USE_EXISTING

echo        正在启动临时下载服务...
set "STARTING_OLLAMA=1"
for /f "delims=" %%p in ('powershell.exe -NoProfile -Command "$p=Start-Process -FilePath $env:OLLAMA_EXE -ArgumentList serve -PassThru -WindowStyle Hidden; $p.Id"') do set "OLLAMA_PID=%%p"
if not defined OLLAMA_PID goto :SERVER_START_FAILED
call :WAIT_SERVER
if not defined OLLAMA_READY goto :SERVER_START_FAILED
goto :DO_PULL

:USE_EXISTING
echo        端口 11435 已有服务在运行，直接复用它下载（不会关闭它）。
set "USING_EXISTING=1"

:DO_PULL
echo.
echo        正在下载 %QWEN_MODEL%，请保持本窗口开启...
echo.
"%OLLAMA_EXE%" pull %QWEN_MODEL%
if errorlevel 1 goto :PULL_FAILED
if exist "%QWEN_DIR%\manifests\registry.ollama.ai\library\qwen3.5\9b" goto :MODEL_OK
if exist "%QWEN_DIR%\manifests-v2\ollama.com\library\qwen3.5\9b" goto :MODEL_OK
goto :PULL_FAILED

:MODEL_OK
call :STOP_OWN_SERVER
echo [2/3] 本地模型已就绪：%QWEN_DIR%
echo.

rem ---------- 第 3 步：绑定模型目录 ----------
echo [3/3] 把 Ollama 绑定到这个模型目录...
setx OLLAMA_MODELS "%QWEN_DIR%" >nul
if errorlevel 1 goto :BIND_FAILED
set "BOUND="
for /f "delims=" %%v in ('powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('OLLAMA_MODELS','User')"') do set "BOUND=%%v"
if not defined BOUND set "BOUND=%QWEN_DIR%"
echo        已写入用户环境变量 OLLAMA_MODELS：
echo        %BOUND%
echo.
echo 全部完成。回到插件：
echo   1. 关掉本地服务窗口再重新双击「启动本地服务.bat」；
echo   2. 刷新扩展后，面板顶部应显示 本地模型:qwen3.5:9b；
echo   3.「作答模型」里就能选 本地 Qwen 了。
echo.
echo 说明：
echo   - 插件启动本地服务时会自己带上这个模型目录，即使 Ollama 托盘程序
echo     指向别处，也不影响插件本地作答。
echo   - 想让命令行 ollama list 也看到该模型，请退出 Ollama 托盘程序再重开。
echo   - 想解除绑定，执行：setx OLLAMA_MODELS ""
goto :EXIT_SUCCESS

rem ---------- 跳过下载 ----------
:SKIP_DOWNLOAD
echo.
echo [跳过] 没有下载模型，本地作答暂不可用，插件会自动改用云端 API。
echo        想装本地模型时，再双击本文件即可。
goto :EXIT_SUCCESS

rem ---------- 错误出口 ----------
:INSTALL_FAILED
echo.
echo [错误] Ollama 安装失败，或安装后仍找不到 ollama.exe。
echo        请检查网络，或从 https://ollama.com/download/windows 手动安装后重试。
goto :EXIT_FAILURE

:MKDIR_FAILED
echo.
echo [错误] 无法创建模型目录：%QWEN_DIR%
goto :EXIT_FAILURE

:SERVER_START_FAILED
echo.
echo [错误] 无法启动临时下载服务（端口 11435）。
call :STOP_OWN_SERVER
echo        请关闭占用 11435 的程序后重试，或先手动启动 ollama serve。
goto :EXIT_FAILURE

:PULL_FAILED
echo.
echo [错误] 模型下载或校验失败。
call :STOP_OWN_SERVER
echo        再次运行本文件可重试，Ollama 会复用已下载的数据块。
goto :EXIT_FAILURE

:BIND_FAILED
echo.
echo [错误] 写入环境变量 OLLAMA_MODELS 失败。
echo        可手动执行：setx OLLAMA_MODELS "%QWEN_DIR%"
goto :EXIT_FAILURE

:EXIT_SUCCESS
echo.
echo 按任意键退出...
pause >nul
exit /b 0

:EXIT_FAILURE
echo.
echo 按任意键退出...
pause >nul
exit /b 1

rem ---------- 子过程 ----------
:FIND_OLLAMA
set "OLLAMA_EXE="
where.exe ollama.exe >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%i in ('where.exe ollama.exe 2^>nul') do if not defined OLLAMA_EXE set "OLLAMA_EXE=%%i"
  if defined OLLAMA_EXE exit /b 0
)
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
  set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
  exit /b 0
)
if exist "%ProgramFiles%\Ollama\ollama.exe" (
  set "OLLAMA_EXE=%ProgramFiles%\Ollama\ollama.exe"
  exit /b 0
)
exit /b 1

:WAIT_SERVER
set "OLLAMA_READY="
for /l %%i in (1,1,45) do (
  powershell.exe -NoProfile -Command "try { Invoke-RestMethod -Uri 'http://127.0.0.1:11435/api/tags' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 (
    set "OLLAMA_READY=1"
    goto :WAIT_DONE
  )
  timeout /t 1 /nobreak >nul
)
:WAIT_DONE
exit /b 0

:STOP_OWN_SERVER
if not defined OLLAMA_PID exit /b 0
taskkill /PID %OLLAMA_PID% /T /F >nul 2>nul
set "OLLAMA_PID="
if defined STARTING_OLLAMA (
  set "STARTING_OLLAMA="
  set "OLLAMA_MODELS="
  set "OLLAMA_HOST="
)
exit /b 0
