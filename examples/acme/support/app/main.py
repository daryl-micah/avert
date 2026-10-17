from fastapi import FastAPI
from pydantic import BaseModel

from app.llm import answer

app = FastAPI()


class Ticket(BaseModel):
    customer_id: str
    message: str


@app.post("/support/reply")
def reply(ticket: Ticket):
    return {"reply": draft_reply(ticket)}


def draft_reply(ticket: Ticket) -> str:
    prompt = f"Customer {ticket.customer_id} wrote: {ticket.message}"
    return answer(prompt)
