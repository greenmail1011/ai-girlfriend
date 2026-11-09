"""模型呼叫：全部走 OpenAI 相容 API，另有 mock 模式方便測介面。"""
import os
import random

from openai import AsyncOpenAI


class Backend:
    def __init__(self, prefix: str):
        self.base_url = os.getenv(f"{prefix}_BASE_URL", "").strip()
        self.api_key = os.getenv(f"{prefix}_API_KEY", "").strip() or "none"
        self.model = os.getenv(f"{prefix}_MODEL", "").strip()
        self.mock = os.getenv("LLM_PROVIDER", "").strip().lower() == "mock" and prefix == "LLM"
        self.client = (
            AsyncOpenAI(base_url=self.base_url or None, api_key=self.api_key)
            if (self.model and not self.mock) else None
        )

    @property
    def available(self) -> bool:
        return self.mock or self.client is not None

    async def chat(self, messages, temperature=0.9, max_tokens=400) -> str:
        if self.mock:
            return _mock_reply(messages)
        if not self.client:
            raise RuntimeError("模型尚未設定，請檢查 .env")
        resp = await self.client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return (resp.choices[0].message.content or "").strip()


def _mock_reply(messages) -> str:
    last = messages[-1]["content"] if messages else ""
    if "整理" in last and "事實" in last:
        return "- （mock）使用者今天有來聊天"
    picks = [
        "[心情:開心]\n欸真的假的||你再多說一點啦 🥺",
        "[心情:撒嬌]\n哼～你都不早點來找我||不過算了，原諒你一次",
        "[心情:平靜]\n嗯嗯我在聽||然後呢？",
        "[心情:吃醋]\n…你剛剛是跟誰在聊天啦||我才沒有在意喔",
    ]
    return random.choice(picks)


main = None
mature = None


def init():
    global main, mature
    main = Backend("LLM")
    mature = Backend("MATURE")
