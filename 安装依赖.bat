@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 跳帮修改器：安装依赖（只需运行一次）====
echo.
where python >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Python。请先安装 Python 3.10 或更高版本，并勾选 "Add to PATH"。
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js / npm。请先安装 Node.js（用于获取 frida-il2cpp-bridge）。
  pause
  exit /b 1
)
if not exist "venv\Scripts\python.exe" (
  echo [1/3] 创建 Python 虚拟环境...
  python -m venv venv || goto :fail
)
echo [2/3] 安装 frida（约 50 MB，来自 PyPI）...
"venv\Scripts\python.exe" -m pip install --disable-pip-version-check "frida==17.23.1" || goto :fail
echo [3/3] 安装 frida-il2cpp-bridge（来自 npm）...
call npm install --no-audit --no-fund || goto :fail
echo.
echo 安装完成。以后双击“启动修改器.bat”即可。
pause
exit /b 0
:fail
echo.
echo 安装失败，请检查上面的错误信息。
pause
exit /b 1
