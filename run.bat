@echo off
cd /d %~dp0
if not exist .venv (python -m venv .venv && .venv\Scripts\pip install -r requirements.txt)
if not exist .env copy .env.example .env
start http://localhost:8000
.venv\Scripts\python -m uvicorn app.main:app --port 8000
