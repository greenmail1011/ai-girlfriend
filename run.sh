#!/usr/bin/env bash
cd "$(dirname "$0")"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -r requirements.txt; }
[ -f .env ] || cp .env.example .env
.venv/bin/python -m uvicorn app.main:app --port 8000
