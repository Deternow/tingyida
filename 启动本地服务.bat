@echo off
chcp 936 >nul
set "PYTHONIOENCODING=gbk"
title 听译答 本地服务
cd /d "%~dp0"

echo ============================================
echo   听译答 本地服务  http://127.0.0.1:8765
echo   使用插件期间请保持本窗口开启
echo ============================================
echo.

set "PY="

rem ---------- 0. 本地模型提示（与是否用 exe 无关，先提示） ----------
if exist "models\qwen\manifests" goto :MODEL_HINT_DONE
if exist "models\qwen\manifests-v2" goto :MODEL_HINT_DONE
echo [提示] 未检测到本地 Qwen 模型：本地作答不可用，插件会自动改用云端 API。
echo        需要本地模型时，关闭本窗口后双击「安装本地模型.bat」。
echo.
:MODEL_HINT_DONE

for /f "delims=" %%P in ('where.exe python.exe 2^>nul') do if not defined PY set "PY=%%P"

rem ---------- 1. 端口占用：找出旧进程，询问是否结束并重启 ----------
set "OLDPID="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765" ^| findstr LISTENING') do set "OLDPID=%%a"
if not defined OLDPID goto :CHECK_EXE

echo [提示] 端口 8765 已被占用。
set "OLDNAME=未知进程"
for /f "tokens=1 delims=," %%n in ('tasklist /FI "PID eq %OLDPID%" /FO CSV /NH') do set "OLDNAME=%%~n"
echo        占用进程：%OLDNAME%  (PID=%OLDPID%)
echo.
echo   多数情况是上次启动的旧服务，结束它才能用上新版代码。
set "ANS=Y"
set /p "ANS=          是否结束该进程并重启服务？(Y/N，直接回车=Y)："
if /i not "%ANS%"=="Y" (
  echo.
  echo   已取消。请手动关掉旧窗口后，再双击本文件。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在结束旧进程 PID=%OLDPID% ...
taskkill /PID %OLDPID% /F >nul 2>nul
if errorlevel 1 (
  echo   [错误] 结束失败，可能权限不足。请在任务管理器手动结束 PID=%OLDPID%
  echo.
  pause
  exit /b 1
)
echo   已结束，3 秒后启动新服务...
timeout /t 3 /nobreak >nul
echo.

rem ---------- 2. 打包版服务优先（无需 Python） ----------
:CHECK_EXE
if exist "%~dp0听译答服务.exe" goto :RUN_EXE
goto :CHECKPY

:RUN_EXE
echo 使用打包版服务：听译答服务.exe（本机无需安装 Python）
echo.
"%~dp0听译答服务.exe"
goto :SERVICE_STOPPED

rem ---------- 3. Python 路径检查（没有 exe 时回退） ----------
:CHECKPY
if not defined PY (
  echo [错误] 未在 PATH 环境变量中找到 python.exe。
  echo        请安装 Python，并在安装时勾选“Add Python to PATH”，然后重新打开本窗口。
  echo.
  pause
  exit /b 1
)
if not exist "%PY%" (
  echo [错误] 找不到 Python：%PY%
  echo        请检查 PATH 环境变量中的 Python 路径。
  echo.
  pause
  exit /b 1
)

rem ---------- 3. 依赖检查 ----------
"%PY%" -c "import flask, vosk" >nul 2>nul
if errorlevel 1 (
  echo [错误] Python 依赖不完整 ^(缺 flask 或 vosk^)。
  echo        请先执行：
  echo        "%PY%" -m pip install flask vosk ctranslate2 sentencepiece
  echo.
  pause
  exit /b 1
)

"%PY%" -c "import soundcard" >nul 2>nul
if errorlevel 1 (
  echo [提示] 缺少 soundcard 库，正在自动安装^("整个电脑"无弹窗录音需要它^)...
  echo.
  "%PY%" -m pip install soundcard
  echo.
  "%PY%" -c "import soundcard" >nul 2>nul
  if errorlevel 1 (
    echo [警告] soundcard 安装失败，"整个电脑"音源将不可用，
    echo        其余功能^(标签页音源 / 麦克风 / 翻译^)不受影响。
    echo        可手动执行："%PY%" -m pip install soundcard
    echo.
    pause
  )
)

rem ---------- 4. 启动 ----------
echo 正在启动服务，首次识别时要加载模型，大约几秒...
echo.
"%PY%" server\server.py
goto :SERVICE_STOPPED


:SERVICE_STOPPED

echo.
echo 服务已停止。
pause
