@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "venv\Scripts\python.exe" (
  echo 没有找到运行环境（venv）。请先双击运行“安装依赖.bat”。
  pause
  exit /b 1
)
echo 调试模式：这个窗口显示启动器日志，后台服务会另开一个控制台窗口显示它的日志。关闭修改器窗口后启动器自动退出；后台服务会等游戏退出后自动结束。
"venv\Scripts\python.exe" -u trainer.py --debug
echo.
echo 修改器已退出。
pause
