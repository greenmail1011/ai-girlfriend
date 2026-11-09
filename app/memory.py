"""SQLite 記憶：對話紀錄、長期記憶（關於使用者的事實）、關係狀態。"""
import sqlite3
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "memory.db"


def _conn():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def init():
    with _conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS messages(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL, content TEXT NOT NULL, ts REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS facts(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT UNIQUE NOT NULL, ts REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT);
            """
        )


# ---------- 對話 ----------
def add_message(role: str, content: str):
    with _conn() as c:
        c.execute("INSERT INTO messages(role, content, ts) VALUES (?,?,?)",
                  (role, content, time.time()))


def recent_messages(n: int):
    with _conn() as c:
        rows = c.execute(
            "SELECT role, content, ts FROM messages ORDER BY id DESC LIMIT ?", (n,)
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


def message_count() -> int:
    with _conn() as c:
        return c.execute("SELECT COUNT(*) FROM messages").fetchone()[0]


def last_message_time():
    with _conn() as c:
        r = c.execute("SELECT ts FROM messages ORDER BY id DESC LIMIT 1").fetchone()
    return r[0] if r else None


# ---------- 長期記憶 ----------
def add_facts(lines):
    with _conn() as c:
        for line in lines:
            line = line.strip()
            if line:
                c.execute("INSERT OR IGNORE INTO facts(content, ts) VALUES (?,?)",
                          (line, time.time()))


def all_facts(limit: int = 80):
    with _conn() as c:
        rows = c.execute(
            "SELECT id, content FROM facts ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


def delete_fact(fact_id: int):
    with _conn() as c:
        c.execute("DELETE FROM facts WHERE id=?", (fact_id,))


# ---------- 狀態 ----------
def get_state(key: str, default=None):
    with _conn() as c:
        r = c.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
    return r[0] if r else default


def set_state(key: str, value):
    with _conn() as c:
        c.execute("INSERT OR REPLACE INTO state(key, value) VALUES (?,?)", (key, str(value)))


def reset(keep_facts: bool = False):
    with _conn() as c:
        c.execute("DELETE FROM messages")
        c.execute("DELETE FROM state")
        if not keep_facts:
            c.execute("DELETE FROM facts")
