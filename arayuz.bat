@echo off
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo Sanal ortam bulunamadi. Once kurulum yapiliyor...
  python -m venv .venv
  .venv\Scripts\python.exe -m pip install -r requirements.txt
)
.venv\Scripts\python.exe -m reels_transfer gui
pause
