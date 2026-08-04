#!/usr/bin/env python3
"""Safe local Proton integration smoke test.

Reads the ignored proton_test_accpunt.json file and prints only non-sensitive
metadata about whether login/list/detail/decryption worked.
"""

from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path

from proton_api import fetch_proton_account


def main() -> None:
    account_path = Path(__file__).with_name("proton_test_accpunt.json")
    payload = json.loads(account_path.read_text(encoding="utf-8"))
    payload["limit"] = min(int(payload.get("limit") or 3), 3)

    logs = io.StringIO()
    with contextlib.redirect_stdout(logs), contextlib.redirect_stderr(logs):
        result = fetch_proton_account(payload)

    emails = result.get("emails") or []
    print(json.dumps({
        "success": bool(result.get("success")),
        "message_count": len(emails),
        "first_subject_present": bool(emails and emails[0].get("subject")),
        "body_decrypted": bool(emails and (emails[0].get("bodyText") or emails[0].get("bodyHtml"))),
        "session_updated": bool((result.get("session") or {}).get("updated")),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
