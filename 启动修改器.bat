@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "venv\Scripts\pythonw.exe" (
  echo 没有找到运行环境（venv）。请先双击运行“安装依赖.bat”。
  pause
  exit /b 1
)
rem 无控制台窗口启动；出错信息会弹窗并写入 trainer.log
start "" "venv\Scripts\pythonw.exe" trainer.py
