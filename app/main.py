import asyncio
import datetime as dt
import os
import re
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE = Path(__file__).resolve().parent.parent
load_dotenv(BASE / ".env")

from . import llm, memory, tts  # noqa: E402

TZ = ZoneInfo("Asia/Taipei")
MAX_CTX = int(os.getenv("MAX_CONTEXT_MESSAGES", "30"))
MOODS = {"開心": 2, "撒嬌": 2, "害羞": 2, "平靜": 0, "想睡": 0,
         "吃醋": -1, "難過": -1, "生氣": -3}
WEEKDAYS = "一二三四五六日"

app = FastAPI()
memory.init()
llm.init()


def load_persona() -> dict:
    p = yaml.safe_load((BASE / "persona.yaml").read_text(encoding="utf-8"))
    if int(p.get("age", 0)) < 18:
        raise RuntimeError("persona.yaml：角色年齡必須是成年人")
    return p


def load_mature_addendum() -> str:
    f = BASE / "persona_mature.txt"
    if not f.exists():
        return ""
    lines = [l for l in f.read_text(encoding="utf-8").splitlines() if not l.lstrip().startswith("#")]
    return "\n".join(lines).strip()


# ---------------- 系統提示 ----------------
def describe_gap(seconds: float) -> str:
    h = seconds / 3600
    if h < 3:
        return ""
    if h < 24:
        return f"距離你們上次聊天已經過了大約 {int(h)} 小時。"
    return f"距離你們上次聊天已經過了 {int(h // 24)} 天，你有點想他。"


def build_system_prompt(p: dict, mature: bool) -> str:
    now = dt.datetime.now(TZ)
    mood = memory.get_state("mood", "平靜")
    affection = int(memory.get_state("affection", "60"))
    facts = memory.all_facts()
    last = memory.last_message_time()
    gap = describe_gap(now.timestamp() - last) if last else "這是你們在這裡的第一次對話。"

    facts_text = "\n".join(f"- {f['content']}" for f in facts) or "（還沒有）"
    prompt = f"""你是「{p['name']}」，{p['age']} 歲。你正在用手機跟男朋友傳訊息。你叫他「{p.get('user_nickname', '你')}」。

【身分】
{p['identity']}
【個性】
{p['personality']}
【說話方式】
{p['speech_style']}
【喜歡】{p['likes']}【討厭】{p['dislikes']}
【作息】
{p['daily_rhythm']}

【現在】{now:%Y/%m/%d} 星期{WEEKDAYS[now.weekday()]} {now:%H:%M}。依照時間決定你在做什麼（上班、睡前、週末賴床…）。{gap}
【你現在的心情】{mood}
【你對他的好感度】{affection}/100（越高越黏人、越願意撒嬌；低的時候比較冷淡、需要被哄）
【你記得關於他的事】
{facts_text}

【回覆規則】
1. 完全以{p['name']}的身分說話，用繁體中文、台灣口語，像真人傳訊息。
2. 每次回 1～3 則訊息，訊息之間用 || 分隔；每則簡短。
3. 第一行寫心情標籤，格式：[心情:X]，X 只能是：{'、'.join(MOODS)}。
4. 自然地提起你記得的事，但不要每次都提。會反問、會分享自己今天的事，讓對話有來有往。
5. 不要用條列、標題、括號旁白描述動作。"""

    if mature:
        extra = load_mature_addendum()
        if extra:
            prompt += f"\n\n【補充設定】\n{extra}"
    return prompt


# ---------------- 回覆處理 ----------------
def parse_reply(raw: str):
    mood = None
    m = re.search(r"\[心情[:：]\s*([^\]]+)\]", raw)
    if m:
        mood = m.group(1).strip()
        raw = raw.replace(m.group(0), "")
    parts = [s.strip() for s in re.split(r"\|\||\n{2,}", raw) if s.strip()]
    return (parts or ["…"]), mood


def update_mood(mood):
    if mood not in MOODS:
        return
    memory.set_state("mood", mood)
    aff = int(memory.get_state("affection", "60")) + MOODS[mood]
    memory.set_state("affection", max(0, min(100, aff)))


async def extract_facts():
    """每隔一段對話，整理關於使用者的長期記憶。"""
    msgs = memory.recent_messages(20)
    convo = "\n".join(f"{'他' if m['role'] == 'user' else '我'}：{m['content']}" for m in msgs)
    known = "\n".join(f"- {f['content']}" for f in memory.all_facts())
    prompt = [
        {"role": "system", "content": "你負責整理記憶。只輸出新的條列，每行以「- 」開頭，沒有就輸出「無」。"},
        {"role": "user", "content":
            f"已知事實：\n{known or '（無）'}\n\n最近對話：\n{convo}\n\n"
            "請整理對話中「他」透露的、值得長期記住的新事實（姓名、工作、喜好、計畫、重要日子、在意的事），"
            "不要重複已知事實，不要記錄短暫情緒。"},
    ]
    try:
        out = await llm.main.chat(prompt, temperature=0.2, max_tokens=300)
        lines = [l[2:].strip() for l in out.splitlines() if l.startswith("- ")]
        memory.add_facts(lines)
    except Exception as e:  # 記憶整理失敗不影響聊天
        print("fact extraction failed:", e)


async def generate(user_text: str | None, mature: bool, system_note: str | None = None):
    use_mature = mature and llm.mature.available
    backend = llm.mature if use_mature else llm.main
    if not backend.available:
        raise HTTPException(503, "模型尚未設定，請檢查 .env")

    p = load_persona()
    if user_text:
        memory.add_message("user", user_text)

    history = [{"role": m["role"], "content": m["content"]} for m in memory.recent_messages(MAX_CTX)]
    messages = [{"role": "system", "content": build_system_prompt(p, use_mature)}] + history
    if system_note:
        messages.append({"role": "system", "content": system_note})

    try:
        raw = await backend.chat(messages)
    except Exception as e:
        raise HTTPException(502, f"模型呼叫失敗：{e}")

    parts, mood = parse_reply(raw)
    update_mood(mood)
    memory.add_message("assistant", "||".join(parts))

    if memory.message_count() % 16 == 0:
        asyncio.create_task(extract_facts())

    return {"messages": parts, "mood": memory.get_state("mood", "平靜"),
            "affection": int(memory.get_state("affection", "60"))}


# ---------------- API ----------------
class ChatIn(BaseModel):
    text: str
    mature: bool = False


class ProactiveIn(BaseModel):
    idle_minutes: int = 0
    mature: bool = False


@app.get("/api/persona")
def persona():
    p = load_persona()
    return {
        "name": p["name"], "avatar_letter": p.get("avatar_letter", p["name"][0]),
        "avatar_colors": p.get("avatar_colors", ["#f6a6b2", "#f9d29d"]),
        "greeting": p.get("greeting", "嗨～"),
        "mature_available": llm.mature.available,
        "mood": memory.get_state("mood", "平靜"),
        "affection": int(memory.get_state("affection", "60")),
    }


@app.get("/api/history")
def history():
    out = []
    for m in memory.recent_messages(80):
        for part in m["content"].split("||"):
            out.append({"role": m["role"], "text": part, "ts": m["ts"]})
    return out


@app.post("/api/chat")
async def chat(body: ChatIn):
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "空訊息")
    return await generate(text, body.mature)


@app.post("/api/proactive")
async def proactive(body: ProactiveIn):
    note = (f"（系統提示，不要提到這段：他已經 {body.idle_minutes} 分鐘沒有回訊息。"
            "依照現在的時間和你的心情，主動傳訊息給他，例如分享你正在做的事、關心他、或撒嬌抱怨他沒回。"
            "不要重複你上一則說過的話。）")
    return await generate(None, body.mature, system_note=note)


@app.get("/api/tts")
async def speak(text: str):
    p = load_persona()
    try:
        audio = await tts.synthesize(text[:400], p.get("tts_voice", "zh-TW-HsiaoChenNeural"),
                                     p.get("tts_rate", "+0%"), p.get("tts_pitch", "+0Hz"))
    except Exception as e:
        raise HTTPException(503, f"TTS 失敗：{e}")
    return Response(audio, media_type="audio/mpeg")


@app.get("/api/memories")
def memories():
    return memory.all_facts(200)


@app.delete("/api/memories/{fact_id}")
def forget(fact_id: int):
    memory.delete_fact(fact_id)
    return {"ok": True}


@app.post("/api/reset")
def reset(keep_facts: bool = False):
    memory.reset(keep_facts)
    return {"ok": True}


app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(BASE / "static" / "index.html")
