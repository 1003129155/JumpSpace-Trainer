@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "venv\Scripts\python.exe" (
  echo 没有找到运行环境（venv）。请先双击运行“安装依赖.bat”。
  pause
  exit /b 1
)
echo ==== 打包：生成 dist\跳帮修改器\ 和 dist\跳帮修改器.zip ====
"venv\Scripts\python.exe" build_app.py
if errorlevel 1 (
  echo.
  echo 打包失败，请检查上面的错误信息。
  pause
  exit /b 1
)
echo.
echo 完成。把 dist\跳帮修改器.zip 发给别人即可，对方解压后双击“跳帮修改器.exe”，不需要安装 Python 或 Node。
pause
