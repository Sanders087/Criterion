"""Internal ASGI endpoint; run behind the operator's trusted TLS/network boundary."""
from __future__ import annotations

import asyncio
import hmac
import json
import os

MAX_BODY_BYTES = 2_000_000


class PrivacyApp:
    def __init__(self, detector, token: str):
        if len(token) < 32 or "\r" in token or "\n" in token:
            raise ValueError("PII_ANALYZER_TOKEN must have at least 32 characters")
        self.detector = detector
        self.authorization = ("Bearer " + token).encode("utf-8")
        self.lock = asyncio.Semaphore(1)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                event = await receive()
                if event["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif event["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope["type"] != "http":
            return

        async def respond(status, payload):
            body = json.dumps(payload, ensure_ascii=True).encode("ascii")
            await send({
                "type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store")],
            })
            await send({"type": "http.response.body", "body": body})

        headers = dict(scope.get("headers", []))
        if not hmac.compare_digest(headers.get(b"authorization", b""), self.authorization):
            return await respond(401, {"error": "unauthorized"})
        if scope.get("path") == "/health" and scope.get("method") == "GET":
            return await respond(200, {"status": "ready"})
        if scope.get("path") != "/analyze" or scope.get("method") != "POST":
            return await respond(404, {"error": "not_found"})
        if headers.get(b"content-type", b"").split(b";", 1)[0].strip() != b"application/json":
            return await respond(415, {"error": "json_required"})
        # No unbounded queue holding plaintext while the model is busy.
        if self.lock.locked():
            return await respond(503, {"error": "busy"})
        async with self.lock:
            body = bytearray()
            try:
                while True:
                    event = await asyncio.wait_for(receive(), timeout=5)
                    if event["type"] == "http.disconnect":
                        return
                    body.extend(event.get("body", b""))
                    if len(body) > MAX_BODY_BYTES:
                        return await respond(413, {"error": "too_large"})
                    if not event.get("more_body"):
                        break
                data = json.loads(body)
                if not isinstance(data, dict) or set(data) != {"texts"}:
                    raise ValueError("invalid_request")
                # Validate before invoking the CPU detector.
                from .detector import validate_texts
                texts = validate_texts(data["texts"])
                result = await asyncio.to_thread(self.detector.detect, texts)
            except (ValueError, UnicodeError, TypeError, RecursionError):
                return await respond(400, {"error": "invalid_request"})
            except asyncio.TimeoutError:
                return await respond(408, {"error": "timeout"})
            except Exception:
                # Never expose exception text: it can include a source span.
                return await respond(503, {"error": "detector_unavailable"})
            finally:
                body.clear()
            return await respond(200, result)


def create_app():
    from .detector import RussianDetector
    return PrivacyApp(RussianDetector(), os.environ.get("PII_ANALYZER_TOKEN", ""))
