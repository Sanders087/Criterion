"""Offline evaluation of independently annotated synthetic data; never contacts a model."""
import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
from unittest.mock import patch

from services.pii.detector import RussianDetector

ROOT = Path(__file__).resolve().parents[2]


def units(text):
    return len(text.encode("utf-16-le")) // 2


def evaluate(corpus, detector):
    metrics = Counter()
    categories = {}
    families = {}
    results = []
    for row in corpus:
        text = row["text"]
        raw = text.encode("utf-16-le")
        gold = set()
        for label in row["sensitive"] + row["keep"]:
            assert 0 <= label["start"] < label["end"] <= units(text), row["id"]
            assert raw[label["start"] * 2:label["end"] * 2].decode("utf-16-le") == label["text"], row["id"]
        for label in row["sensitive"]:
            gold.update(range(label["start"], label["end"]))
        for label in row["keep"]:
            assert not gold.intersection(range(label["start"], label["end"])), row["id"]
        detection = detector.detect([text])
        covered = set()
        for span in detection["spans"]:
            assert 0 <= span["start"] < span["end"] <= units(text), row["id"]
            covered.update(range(span["start"], span["end"]))
        missed, damaged = [], []
        for label in row["sensitive"]:
            category = categories.setdefault(label["entityType"], Counter())
            category["total"] += 1
            if set(range(label["start"], label["end"])) <= covered:
                category["fullyCovered"] += 1
                metrics["fullyCoveredSpans"] += 1
            else:
                missed.append(label)
        for label in row["keep"]:
            if covered.intersection(range(label["start"], label["end"])):
                damaged.append(label)
        negative_failure = not row["sensitive"] and bool(covered)
        passed = not missed and not damaged and not negative_failure
        family = families.setdefault(row["family"], Counter())
        family["cases"] += 1
        family["passed"] += passed
        metrics.update({"cases": 1, "passedCases": int(passed),
                        "sensitiveSpans": len(row["sensitive"]), "missedSpans": len(missed),
                        "keepSpans": len(row["keep"]), "damagedKeepSpans": len(damaged),
                        "negativeCases": int(not row["sensitive"]),
                        "negativeFailures": int(negative_failure),
                        "goldUnits": len(gold), "coveredGoldUnits": len(gold & covered),
                        "extraMaskedUnits": len(covered - gold), "predictedUnits": len(covered)})
        results.append({"id": row["id"], "suite": row["suite"], "passed": passed,
                        "missed": missed, "damagedKeep": damaged,
                        "negativeFailure": negative_failure, "detection": detection})
    report = {"syntheticOnly": True, "independentHoldout": False,
              "offsetUnit": "utf16", "metrics": dict(metrics),
              "entityCoverage": (round(metrics["fullyCoveredSpans"] / metrics["sensitiveSpans"], 6) if metrics["sensitiveSpans"] else None),
              "characterRecall": (round(metrics["coveredGoldUnits"] / metrics["goldUnits"], 6) if metrics["goldUnits"] else None),
              "categories": categories, "families": families, "results": results}
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--strict", action="store_true", help="Exit nonzero for any corpus failure")
    args = parser.parse_args()
    corpus = [json.loads(line) for line in (ROOT / "tests/fixtures/pii-corpus.jsonl").read_text(encoding="utf-8").splitlines()]
    assert len({row["id"] for row in corpus}) == len(corpus)
    with patch("socket.socket.connect", side_effect=AssertionError("network forbidden")):
        report = evaluate(corpus, RussianDetector())
    report["corpusSha256"] = hashlib.sha256((ROOT / "tests/fixtures/pii-corpus.jsonl").read_bytes()).hexdigest()
    report["detectorSha256"] = hashlib.sha256((ROOT / "services/pii/detector.py").read_bytes()).hexdigest()
    report["uniqueTexts"] = len({row["text"] for row in corpus})
    report["sourceTemplates"] = len({row["family"] for row in corpus} - {"composite"})
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"metrics": report["metrics"], "entityCoverage": report["entityCoverage"],
                      "failedFamilies": {k: v for k, v in report["families"].items() if v["passed"] != v["cases"]}}, ensure_ascii=False))
    if args.strict and report["metrics"]["passedCases"] != report["metrics"]["cases"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
