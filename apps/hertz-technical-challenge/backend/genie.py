"""Ask the Databricks Genie space questions about the data (Genie Conversation API).

The space is attached to the app as a resource; app.yaml passes its ID as GENIE_SPACE_ID.
Locally, export GENIE_SPACE_ID yourself (your CLI login is used).
"""
import os
from datetime import timedelta
from functools import lru_cache

from databricks.sdk import WorkspaceClient

MAX_ROWS = 50
TIMEOUT = timedelta(seconds=120)


def space_id() -> str | None:
    return os.environ.get("GENIE_SPACE_ID") or None


@lru_cache(maxsize=1)
def _client() -> WorkspaceClient:
    return WorkspaceClient()


def ask(question: str, conversation_id: str | None = None) -> dict:
    """Send a question (continuing a conversation if given) and return Genie's answer:
    text, the SQL it ran, and up to MAX_ROWS rows of the result."""
    sid = space_id()
    if not sid:
        raise RuntimeError("Genie isn't connected: attach a Genie space resource with key 'genie-space'.")
    w = _client()
    if conversation_id:
        msg = w.genie.create_message_and_wait(sid, conversation_id, question, timeout=TIMEOUT)
    else:
        msg = w.genie.start_conversation_and_wait(sid, question, timeout=TIMEOUT)

    answer = {"conversation_id": msg.conversation_id, "message_id": msg.message_id,
              "status": msg.status.value if msg.status else None,
              "text": [], "sql": None, "sql_description": None,
              "columns": [], "rows": [], "row_count": 0, "suggested": []}
    if msg.error:
        answer["text"].append(f"Genie couldn't answer: {getattr(msg.error, 'error', msg.error)}")

    for att in msg.attachments or []:
        if att.text and att.text.content:
            answer["text"].append(att.text.content)
        if att.suggested_questions and getattr(att.suggested_questions, "questions", None):
            answer["suggested"] = list(att.suggested_questions.questions)
        if att.query and att.query.query:
            answer["sql"] = att.query.query
            answer["sql_description"] = att.query.description
            try:
                res = w.genie.get_message_attachment_query_result(
                    sid, msg.conversation_id, msg.message_id, att.attachment_id).statement_response
                if res and res.manifest and res.manifest.schema:
                    answer["columns"] = [c.name for c in res.manifest.schema.columns or []]
                data = (res.result.data_array if res and res.result else None) or []
                answer["rows"] = data[:MAX_ROWS]
                answer["row_count"] = (res.manifest.total_row_count if res and res.manifest
                                       and res.manifest.total_row_count is not None else len(data))
            except Exception as exc:                     # the text answer is still useful
                answer["text"].append(f"(Couldn't load the result table: {exc})")
    return answer
