"""All fixtures are synthetic. No provider/model API or real email is used."""
import asyncio
import json
import unittest
from unittest.mock import patch

from services.pii.app import PrivacyApp, MAX_BODY_BYTES
from services.pii.detector import RussianDetector, utf16_offset, validate_texts

TOKEN = "fixture-private-service-token-123456"


def extracts(text, spans):
    raw = text.encode("utf-16-le")
    return [raw[s["start"] * 2:s["end"] * 2].decode("utf-16-le") for s in spans]


class DetectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with patch("socket.socket.connect", side_effect=AssertionError("network forbidden")):
            cls.detector = RussianDetector()

    def test_identifiers_and_russian_name(self):
        text = (
            "Иван Иванов заключает договор. Email test-person@example.test; "
            "телефон +7 (900) 111-22-33; паспорт 4510 123456; "
            "СНИЛС 123-456-789 00; ИНН 123456789012; "
            "счёт 40817810000000000000; адрес: ул. Тестовая, дом 7"
        )
        with patch("socket.socket.connect", side_effect=AssertionError("network forbidden")):
            result = self.detector.detect([text])
        found = extracts(text, result["spans"])
        for expected in ["Иван Иванов", "test-person@example.test", "+7 (900) 111-22-33",
                         "4510 123456", "123-456-789 00", "123456789012", "40817810000000000000"]:
            self.assertTrue(any(expected in value for value in found), expected)
        self.assertTrue(any("Тестовая" in value for value in found))
        self.assertEqual(result["offsetUnit"], "utf16")

    def test_emoji_offsets_and_no_source_text_in_results(self):
        text = "😀 Иван Иванов пишет на test-person@example.test."
        result = self.detector.detect([text])
        self.assertIn("test-person@example.test", extracts(text, result["spans"]))
        self.assertEqual(utf16_offset("😀Иван", 1), 2)
        self.assertNotIn("Иван", json.dumps(result, ensure_ascii=False))
        self.assertNotIn("example.test", json.dumps(result))

    def test_amount_and_contract_date_are_not_blanket_redacted(self):
        text = "Цена 45 000 рублей. Срок до 01.12.2026. Аванс 50%."
        self.assertEqual(self.detector.detect([text])["spans"], [])

    def test_birth_date_has_specific_context(self):
        text = "Дата рождения: 01.02.1990; срок работ до 01.12.2026."
        found = extracts(text, self.detector.detect([text])["spans"])
        self.assertTrue(any("01.02.1990" in value for value in found))
        self.assertFalse(any("01.12.2026" in value for value in found))

    def test_labeled_passports_and_birth_dates(self):
        text = (
            "Паспорт заказчика: серия 4510, номер 123456, выдан 15.04.2016. "
            "Дата рождения заказчика: 12.03.1990. "
            "Паспорт исполнителя: серия 4012, номер 654321. "
            "Дата рождения исполнителя: 25.08.1988. "
            "Срок услуг с 01.12.2026 по 28.02.2027."
        )
        found = extracts(text, self.detector.detect([text])["spans"])
        for expected in ["4510", "123456", "4012", "654321", "15.04.2016", "12.03.1990", "25.08.1988"]:
            self.assertTrue(any(expected in value for value in found), expected)
        for ordinary in ["01.12.2026", "28.02.2027"]:
            self.assertFalse(any(ordinary in value for value in found), ordinary)

    def test_document_issue_date_labels(self):
        for label in ["выдан", "Дата выдачи:", "Дата выдачи паспорта:",
                      "Дата выдачи паспорта заказчика:", "Дата выдачи исполнителя ="]:
            for date in ["15.04.2016", "15/04/2016", "15-04-2016"]:
                with self.subTest(label=label, date=date):
                    text = f"{label} {date}. Срок услуг с 01.12.2026 по 28.02.2027."
                    found = extracts(text, self.detector.detect([text])["spans"])
                    self.assertTrue(any(date in value for value in found), found)
                    for ordinary in ["01.12.2026", "28.02.2027"]:
                        self.assertFalse(any(ordinary in value for value in found), found)

    def test_address_stops_before_next_sentence(self):
        for address in [
            "Адрес заказчика: г. Москва, ул. Тестовая, д. 15, кв. 42",
            "Адрес исполнителя: г. Санкт-Петербург, ул. Примерная, д. 8, кв. 17",
            "Офис расположен по адресу: г. Москва, ул. Учебная, д. 20, офис 305",
        ]:
            with self.subTest(address=address):
                text = address + ". Исполнитель обслуживает 12 компьютеров и 2 принтера. Срок с 01.12.2026."
                spans = self.detector.detect([text])["spans"]
                found = extracts(text, spans)
                self.assertTrue(any(value.endswith(("42", "17", "305")) for value in found))
                boundary = utf16_offset(text, len(address))
                self.assertTrue(all(span["end"] <= boundary for span in spans), found)

    def test_input_validation(self):
        for value in [None, "text", [], [123], ["x" * 500_001], ["\ud800"]]:
            with self.assertRaises((ValueError, UnicodeError)):
                validate_texts(value)


class BenchmarkTests(unittest.TestCase):
    def test_partial_coverage_and_overmasking_are_failures(self):
        from services.pii.benchmark import evaluate

        class PartialDetector:
            def detect(self, texts):
                return {"spans": [{"start": 0, "end": 1}, {"start": 2, "end": 3}]}

        corpus = [{"id": "synthetic", "family": "unit", "suite": "core", "text": "AB7",
                   "sensitive": [{"start": 0, "end": 2, "text": "AB", "entityType": "PERSON"}],
                   "keep": [{"start": 2, "end": 3, "text": "7"}]}]
        report = evaluate(corpus, PartialDetector())
        self.assertEqual(report["metrics"]["missedSpans"], 1)
        self.assertEqual(report["metrics"]["damagedKeepSpans"], 1)
        self.assertEqual(report["metrics"]["passedCases"], 0)
        self.assertEqual(report["characterRecall"], 0.5)

    def test_negative_case_detects_any_false_positive(self):
        from services.pii.benchmark import evaluate

        class ExtraDetector:
            def detect(self, texts):
                return {"spans": [{"start": 0, "end": 2}]}

        row = {"id": "negative", "family": "unit", "suite": "core", "text": "😀 ok", "sensitive": [], "keep": []}
        report = evaluate([row], ExtraDetector())
        self.assertEqual(report["metrics"]["negativeFailures"], 1)
        self.assertEqual(report["metrics"]["extraMaskedUnits"], 2)


class FakeDetector:
    def __init__(self):
        self.calls = 0

    def detect(self, texts):
        self.calls += 1
        return {"profile": "ru-contract-v1", "offsetUnit": "utf16", "spans": []}


async def request(app, body, authorization=TOKEN, content_type=b"application/json", path="/analyze", method="POST"):
    events = []
    scope = {
        "type": "http", "method": method, "path": path,
        "headers": [(b"authorization", ("Bearer " + authorization).encode()),
                    (b"content-type", content_type)],
    }

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(event):
        events.append(event)

    await app(scope, receive, send)
    return events[0]["status"], json.loads(events[1]["body"])


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_authentication_before_detector(self):
        detector = FakeDetector()
        status, data = await request(PrivacyApp(detector, TOKEN), b'{"texts":["secret"]}', authorization="wrong")
        self.assertEqual(status, 401)
        self.assertEqual(detector.calls, 0)
        self.assertNotIn("secret", str(data))

    async def test_health_requires_token_and_does_not_run_detection(self):
        detector = FakeDetector()
        app = PrivacyApp(detector, TOKEN)
        status, _ = await request(app, b"", authorization="wrong", path="/health", method="GET")
        self.assertEqual(status, 401)
        status, data = await request(app, b"", path="/health", method="GET")
        self.assertEqual(status, 200)
        self.assertEqual(data, {"status": "ready"})
        self.assertEqual(detector.calls, 0)

    async def test_success_and_private_cache_policy(self):
        detector = FakeDetector()
        status, data = await request(PrivacyApp(detector, TOKEN), b'{"texts":["synthetic"]}')
        self.assertEqual(status, 200)
        self.assertEqual(data["profile"], "ru-contract-v1")
        self.assertEqual(detector.calls, 1)

    async def test_invalid_and_oversized_inputs(self):
        detector = FakeDetector()
        app = PrivacyApp(detector, TOKEN)
        for body, expected in [(b'{"texts":[123]}', 400), (b"invalid", 400),
                               (b'{"texts":["ok"],"extra":1}', 400),
                               (b"x" * (MAX_BODY_BYTES + 1), 413)]:
            status, _ = await request(app, body)
            self.assertEqual(status, expected)
        self.assertEqual(detector.calls, 0)

    async def test_wrong_content_type(self):
        detector = FakeDetector()
        status, _ = await request(PrivacyApp(detector, TOKEN), b'{"texts":["ok"]}', content_type=b"text/plain")
        self.assertEqual(status, 415)
        self.assertEqual(detector.calls, 0)

    async def test_errors_do_not_echo_input_or_exception(self):
        class Broken:
            def detect(self, texts):
                raise RuntimeError("private Иванов")
        status, data = await request(PrivacyApp(Broken(), TOKEN), b'{"texts":["synthetic"]}')
        self.assertEqual(status, 503)
        self.assertNotIn("Иванов", str(data))

    async def test_busy_service_has_no_unbounded_queue(self):
        detector = FakeDetector()
        app = PrivacyApp(detector, TOKEN)
        await app.lock.acquire()
        try:
            status, _ = await request(app, b'{"texts":["synthetic"]}')
        finally:
            app.lock.release()
        self.assertEqual(status, 503)
        self.assertEqual(detector.calls, 0)


if __name__ == "__main__":
    unittest.main()
