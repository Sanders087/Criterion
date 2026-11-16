"""Container readiness check: no source text, logs, or model calls."""
import os
from urllib.request import Request, urlopen


def main():
    request = Request("http://127.0.0.1:8100/health", headers={
        "Authorization": "Bearer " + os.environ.get("PII_ANALYZER_TOKEN", ""),
    })
    try:
        with urlopen(request, timeout=3) as response:
            return 0 if response.status == 200 else 1
    except Exception:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
