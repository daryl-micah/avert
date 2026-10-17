import anthropic
from openai import OpenAI

openai_client = OpenAI()
claude = anthropic.Anthropic()

PRIMARY_MODEL = "gpt-4o-2024-08-06"


def answer(prompt: str) -> str:
    try:
        res = openai_client.chat.completions.create(
            model=PRIMARY_MODEL,
            messages=[{"role": "user", "content": prompt}],
        )
        return res.choices[0].message.content
    except Exception:
        # Fallback provider. Rolling alias: whatever "latest" points at today.
        msg = claude.messages.create(
            model="claude-3-5-sonnet-latest",
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        return msg.content[0].text
