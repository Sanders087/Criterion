"""Synthetic remote smoke test. Token from env only; no source/header logging."""
import argparse
import json
import os
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    args = parser.parse_args()
    url = urlsplit(args.url)
    if (url.scheme != "https" and not (url.scheme == "http" and url.hostname in {"127.0.0.1", "localhost", "::1"})) or url.path != "/analyze" or url.username or url.password or url.query or url.fragment:
        raise ValueError("Use HTTPS /analyze (HTTP allowed only on loopback).")
    token = os.environ.get("PII_ANALYZER_TOKEN", "")
    if len(token) < 32 or "\r" in token or "\n" in token:
        raise ValueError("Set PII_ANALYZER_TOKEN securely in the process environment.")
    text = "Паспорт: серия 4510, номер 123456, выдан 15.04.2016. Почта test-person@example.test. Цена 45 000 рублей. Срок до 01.12.2026."
    body = json.dumps({"texts": [text]}).encode()
    opener = build_opener(NoRedirect())

    def send(authorized):
        headers = {"Content-Type": "application/json"}
        if authorized:
            headers["Authorization"] = "Bearer " + token
        request = Request(args.url, data=body, headers=headers)
        try:
            with opener.open(request, timeout=8) as response:
                return response.status, response.read(2_000_001)
        except HTTPError as error:
            status = error.code
            error.close()
            return status, b""

    status, _ = send(False)
    if status != 401:
        raise ValueError(f"Expected 401 without token; got {status}.")
    started = time.monotonic()
    status, content = send(True)
    if status != 200 or len(content) > 2_000_000:
        raise ValueError(f"Authorized request failed; HTTP {status}.")
    result = json.loads(content)
    if result.get("profile") != "ru-contract-v1" or result.get("offsetUnit") != "utf16":
        raise ValueError("Unexpected detector protocol.")
    covered = set()
    for span in result["spans"]:
        if span["textIndex"] != 0 or not 0 <= span["start"] < span["end"] <= len(text):
            raise ValueError("Invalid span.")
        covered.update(range(span["start"], span["end"]))
    for value in ["4510", "123456", "15.04.2016", "test-person@example.test"]:
        start = text.index(value)
        if not set(range(start, start + len(value))) <= covered:
            raise ValueError("Synthetic sensitive field was not fully detected.")
    for value in ["45 000 рублей", "01.12.2026"]:
        start = text.index(value)
        if covered.intersection(range(start, start + len(value))):
            raise ValueError("Synthetic contract term was masked.")
    print(json.dumps({"ok": True, "unauthorizedStatus": 401, "authorizedStatus": 200,
                      "elapsedMs": round((time.monotonic() - started) * 1000), "profile": result["profile"]}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, URLError, TimeoutError) as error:
        # Never print HTTP response bodies, credentials, or source payloads.
        print("PII endpoint check failed: " + type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
