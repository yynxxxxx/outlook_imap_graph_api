#!/usr/bin/env python3
"""JSON adapter for Proton Mail fetching.

The Node API sends one JSON object through stdin and receives one normalized JSON
object through stdout. All noisy logs from proton_register.py are captured so the
HTTP layer never sees credentials or protocol chatter.
"""

from __future__ import annotations

import contextlib
import html
import io
import json
import os
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any

from proton_register import (
    bind_authenticated_session,
    decrypt_message_body,
    fetch_message,
    fetch_messages,
    get_address_key_passphrases,
    get_address_private_keys,
    login_proton,
    refresh_session,
)

SENSITIVE_KEYS = (
    "password",
    "access_token",
    "refresh_token",
    "AccessToken",
    "RefreshToken",
    "Authorization",
)

DEFAULT_MESSAGE_CONCURRENCY = 3
MAX_MESSAGE_CONCURRENCY = 6


class PublicProtonError(Exception):
    def __init__(self, code: str, message: str, reason: str, action: str, status_code: int = 200):
        super().__init__(message)
        self.code = code
        self.reason = reason
        self.action = action
        self.status_code = status_code


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        with capture_logs():
            result = fetch_proton_account(payload)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    except PublicProtonError as exc:
        write_error(exc.code, str(exc), exc.reason, exc.action, exc.status_code)
    except Exception as exc:
        write_error(
            "PROTON_FETCH_FAILED",
            "Proton API 取件失败",
            sanitize_text(str(exc)),
            "请检查 Proton 账号、密码、会话令牌和网络代理设置后重试",
        )


@contextlib.contextmanager
def capture_logs():
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        yield


def fetch_proton_account(payload: dict[str, Any]) -> dict[str, Any]:
    email = normalize_email(payload.get("email") or payload.get("username"))
    password = str(payload.get("password") or "")
    uid = str(payload.get("uid") or "")
    access_token = str(payload.get("accessToken") or payload.get("access_token") or "")
    refresh_token = str(payload.get("refreshToken") or payload.get("refresh_token") or "")
    limit = clamp_int(payload.get("limit"), default=10, minimum=1, maximum=30)
    keyword = str(payload.get("keyword") or "").strip().lower()
    sender = str(payload.get("sender") or "").strip().lower()
    label_id = str(payload.get("labelId") or payload.get("folder") or "0")

    if not email:
        raise PublicProtonError(
            "PROTON_EMAIL_REQUIRED",
            "缺少 Proton 邮箱",
            "请求中没有 email/username 字段",
            "请导入完整 Proton 邮箱地址后重试",
            400,
        )
    if not password:
        raise PublicProtonError(
            "PROTON_PASSWORD_REQUIRED",
            "Proton 解密取件需要账号密码",
            "Proton 邮件正文使用账号私钥加密，服务端需要密码派生私钥口令才能解密正文",
            "请按 邮箱----密码 格式导入 Proton 账号，或补充 password 字段",
            400,
        )

    session = None
    session_tokens: dict[str, Any] = {}
    used_saved_session = bool(uid and (access_token or refresh_token))
    try:
        if uid and access_token:
            session = bind_authenticated_session(
                uid=uid,
                access_token=access_token,
                refresh_token=refresh_token or None,
                expires_in=payload.get("expiresIn") or payload.get("expires_in"),
                scope=payload.get("scope"),
            )
            session_tokens = {
                "uid": uid,
                "accessToken": access_token,
                "refreshToken": refresh_token or None,
                "expiresIn": payload.get("expiresIn") or payload.get("expires_in"),
            }
        elif uid and refresh_token:
            session = bind_authenticated_session(uid=uid, access_token="placeholder")
            session_tokens = normalize_token_result(refresh_session(session, refresh_token, uid))
        else:
            creds = login_proton(email, password)
            session = creds["sess"]
            uid = creds.get("uid") or uid
            refresh_token = creds.get("refresh_token") or refresh_token
            session_tokens = {
                "uid": creds.get("uid"),
                "accessToken": creds.get("access_token"),
                "refreshToken": creds.get("refresh_token"),
                "expiresIn": creds.get("expires_in"),
                "scope": creds.get("scope"),
            }

        try:
            raw_messages = fetch_with_optional_refresh(session, uid, refresh_token, limit, label_id, session_tokens)
        except Exception as exc:
            if not used_saved_session or not password or not looks_like_auth_error(exc):
                raise
            creds = login_proton(email, password)
            session = creds["sess"]
            uid = creds.get("uid") or uid
            refresh_token = creds.get("refresh_token") or refresh_token
            session_tokens = {
                "uid": creds.get("uid"),
                "accessToken": creds.get("access_token"),
                "refreshToken": creds.get("refresh_token"),
                "expiresIn": creds.get("expires_in"),
                "scope": creds.get("scope"),
                "updated": True,
            }
            raw_messages = fetch_messages(session, page=0, page_size=limit, label_id=label_id)
        filtered_messages = filter_message_metadata(raw_messages, keyword, sender)

        address_keys = get_address_private_keys(session) if filtered_messages else []
        passphrases = get_address_key_passphrases(session, password, address_keys) if address_keys else {}
        emails = normalize_messages(
            session,
            filtered_messages[:limit],
            address_keys,
            passphrases,
            session_tokens,
        )
    except PublicProtonError:
        raise
    except Exception as exc:
        raise classify_proton_error(exc) from exc

    return {
        "success": True,
        "protocol": "proton",
        "count": len(emails),
        "emails": emails,
        "session": prune_empty({
            **session_tokens,
            "updated": bool(session_tokens.get("updated")),
        }),
    }


def fetch_with_optional_refresh(session, uid: str, refresh_token: str, limit: int, label_id: str, session_tokens: dict[str, Any]):
    try:
        return fetch_messages(session, page=0, page_size=limit, label_id=label_id)
    except Exception as exc:
        if not uid or not refresh_token or not looks_like_auth_error(exc):
            raise
        refreshed = refresh_session(session, refresh_token, uid)
        session_tokens.update(normalize_token_result(refreshed))
        session_tokens["updated"] = True
        return fetch_messages(session, page=0, page_size=limit, label_id=label_id)


def normalize_message(session, msg: dict[str, Any], address_keys: list[dict[str, Any]], passphrases: dict[str, list[str]]) -> dict[str, Any]:
    message_id = msg.get("ID") or msg.get("ConversationID") or ""
    detail = fetch_message(session, message_id, format_body=True)
    body_text = decrypt_message_body(detail, address_keys, passphrases)
    body_html = body_text if looks_like_html(body_text) else ""
    plain_text = html_to_text(body_text) if body_html else body_text
    timestamp = detail.get("Time") or msg.get("Time")

    return {
        "id": message_id,
        "messageId": message_id,
        "subject": detail.get("Subject") or msg.get("Subject") or "(无主题)",
        "from": detail.get("SenderAddress") or msg.get("SenderAddress") or "未知",
        "fromName": detail.get("SenderName") or msg.get("SenderName") or "",
        "date": unix_to_iso(timestamp),
        "bodyPreview": truncate(plain_text, 240),
        "bodyHtml": body_html,
        "bodyText": plain_text,
        "hasAttachments": bool(detail.get("NumAttachments") or msg.get("NumAttachments") or 0),
        "folder": "inbox",
        "protocol": "proton",
    }


def normalize_messages(
    session,
    messages: list[dict[str, Any]],
    address_keys: list[dict[str, Any]],
    passphrases: dict[str, list[str]],
    session_tokens: dict[str, Any],
) -> list[dict[str, Any]]:
    if not messages:
        return []

    concurrency = get_message_concurrency(len(messages))
    if concurrency <= 1:
        return [normalize_message(session, msg, address_keys, passphrases) for msg in messages]

    auth_context = get_session_auth_context(session, session_tokens)
    if not auth_context.get("uid") or not auth_context.get("accessToken"):
        return [normalize_message(session, msg, address_keys, passphrases) for msg in messages]

    worker_state = threading.local()

    def get_worker_session():
        worker_session = getattr(worker_state, "session", None)
        if worker_session is None:
            worker_session = bind_authenticated_session(
                uid=auth_context["uid"],
                access_token=auth_context["accessToken"],
                refresh_token=auth_context.get("refreshToken"),
                expires_in=auth_context.get("expiresIn"),
                scope=auth_context.get("scope"),
            )
            worker_state.session = worker_session
        return worker_session

    def normalize_at(index: int, msg: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        return index, normalize_message(get_worker_session(), msg, address_keys, passphrases)

    results: list[dict[str, Any] | None] = [None] * len(messages)
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [
            executor.submit(normalize_at, index, msg)
            for index, msg in enumerate(messages)
        ]
        for future in as_completed(futures):
            index, email = future.result()
            results[index] = email

    return [email for email in results if email is not None]


def get_message_concurrency(message_count: int) -> int:
    configured = os.environ.get("PROTON_MESSAGE_CONCURRENCY")
    return min(
        message_count,
        clamp_int(
            configured,
            default=DEFAULT_MESSAGE_CONCURRENCY,
            minimum=1,
            maximum=MAX_MESSAGE_CONCURRENCY,
        ),
    )


def get_session_auth_context(session, session_tokens: dict[str, Any]) -> dict[str, Any]:
    authorization = str(session.headers.get("Authorization") or "")
    bearer_token = authorization.removeprefix("Bearer ").strip()
    return prune_empty({
        "uid": session_tokens.get("uid") or session.headers.get("X-Pm-Uid"),
        "accessToken": session_tokens.get("accessToken") or bearer_token,
        "refreshToken": session_tokens.get("refreshToken"),
        "expiresIn": session_tokens.get("expiresIn"),
        "scope": session_tokens.get("scope"),
    })


def filter_message_metadata(messages: list[dict[str, Any]], keyword: str, sender: str) -> list[dict[str, Any]]:
    result = []
    for msg in messages:
        if sender and sender not in str(msg.get("SenderAddress") or "").lower():
            continue
        if keyword:
            haystack = " ".join([
                str(msg.get("Subject") or ""),
                str(msg.get("SenderName") or ""),
                str(msg.get("SenderAddress") or ""),
            ]).lower()
            if keyword not in haystack:
                continue
        result.append(msg)
    return result


def classify_proton_error(exc: Exception) -> PublicProtonError:
    raw = sanitize_text(str(exc))
    lower = raw.lower()
    if "wrongpassword" in lower or "srp 登录失败" in raw or "auth/info 失败" in raw:
        return PublicProtonError(
            "PROTON_AUTH_FAILED",
            "Proton 登录失败",
            "Proton 拒绝账号密码或 SRP 登录挑战失败",
            "请确认 Proton 邮箱和密码正确；如果账号开启额外验证，当前接口可能无法自动完成",
        )
    if "401" in raw or "无效的访问令牌" in raw or "token" in lower and "失败" in raw:
        return PublicProtonError(
            "PROTON_TOKEN_INVALID",
            "Proton 会话令牌无效或已过期",
            "Proton API 返回了认证失败，可能是 access_token 过期、refresh_token 已轮换或 UID 不匹配",
            "请使用账号密码重新登录取件，或导入最新的 Proton refresh_token",
        )
    if "解密失败" in raw:
        return PublicProtonError(
            "PROTON_DECRYPT_FAILED",
            "Proton 邮件正文解密失败",
            "邮件正文已获取，但当前密码无法解开地址私钥或邮件 PGP 内容",
            "请确认导入的是该 Proton 账号的正确密码",
        )
    return PublicProtonError(
        "PROTON_FETCH_FAILED",
        "Proton API 取件失败",
        raw,
        "请检查 Proton 账号、密码、会话令牌和网络代理设置后重试",
    )


def write_error(code: str, message: str, reason: str, action: str, status_code: int = 200) -> None:
    print(json.dumps({
        "success": False,
        "protocol": "proton",
        "code": code,
        "error": sanitize_text(message),
        "reason": sanitize_text(reason),
        "action": sanitize_text(action),
        "statusCode": status_code,
        "emails": [],
    }, ensure_ascii=False, separators=(",", ":")))


def normalize_token_result(data: dict[str, Any]) -> dict[str, Any]:
    return prune_empty({
        "uid": data.get("uid"),
        "accessToken": data.get("access_token"),
        "refreshToken": data.get("refresh_token"),
        "expiresIn": data.get("expires_in"),
        "scope": data.get("scope"),
    })


def normalize_email(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if "@" in text:
        return text
    return f"{text}@proton.me"


def clamp_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except Exception:
        number = default
    return max(minimum, min(maximum, number))


def unix_to_iso(value: Any) -> str:
    try:
        number = float(value)
        if number > 10_000_000_000:
            number = number / 1000
        return datetime.fromtimestamp(number, tz=timezone.utc).isoformat()
    except Exception:
        return datetime.now(tz=timezone.utc).isoformat()


def looks_like_html(value: str) -> bool:
    return bool(re.search(r"</?[a-z][\s\S]*>", value or "", re.I))


def html_to_text(value: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", value or "")
    text = re.sub(r"(?s)<br\s*/?>", "\n", text)
    text = re.sub(r"(?s)</p\s*>", "\n", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    return re.sub(r"[ \t\r\f\v]+", " ", html.unescape(text)).strip()


def truncate(value: str, max_len: int) -> str:
    text = re.sub(r"\s+", " ", value or "").strip()
    return text if len(text) <= max_len else text[:max_len] + "..."


def looks_like_auth_error(exc: Exception) -> bool:
    lower = str(exc).lower()
    return (
        "401" in lower
        or "token" in lower
        or "10013" in lower
        or "无效的访问令牌" in lower
        or "无效的刷新令牌" in lower
        or "令牌续期失败" in lower
    )


def sanitize_text(value: Any) -> str:
    text = str(value or "")
    for key in SENSITIVE_KEYS:
        text = re.sub(rf"(['\"]?{re.escape(key)}['\"]?\s*[:=]\s*)['\"]?[^,'\"\s}}]+", rf"\1[redacted]", text, flags=re.I)
    text = re.sub(r"Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted]", text)
    return text[:1200]


def prune_empty(data: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in data.items() if value not in (None, "", [], {})}


if __name__ == "__main__":
    main()
