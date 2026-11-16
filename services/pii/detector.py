"""Local-only Russian detection. No LLM, outbound requests or request logging."""
from __future__ import annotations

from natasha import Doc, NewsEmbedding, NewsNERTagger, Segmenter
from presidio_analyzer import EntityRecognizer, Pattern, PatternRecognizer, RecognizerResult

PROFILE = "ru-contract-v1"
MAX_TEXTS = 4000
MAX_CHARS = 500_000
MAX_SPANS = 20_000


class NatashaRussianRecognizer(EntityRecognizer):
    """Presidio recognizer backed by Natasha's bundled Russian NER model."""

    def __init__(self):
        super().__init__(
            supported_entities=["PERSON", "LOCATION", "ORGANIZATION"],
            supported_language="ru",
            name="CriterionNatashaRecognizer",
        )

    def load(self):
        self.segmenter = Segmenter()
        self.tagger = NewsNERTagger(NewsEmbedding())

    def analyze(self, text, entities, nlp_artifacts=None):
        doc = Doc(text)
        doc.segment(self.segmenter)
        doc.tag_ner(self.tagger)
        types = {"PER": "PERSON", "LOC": "LOCATION", "ORG": "ORGANIZATION"}
        return [
            RecognizerResult(types[span.type], span.start, span.stop, 0.8)
            for span in doc.spans
            if span.type in types and types[span.type] in entities
        ]


# Conservative candidates, not validators. A typo/checksum failure must not
# authorize sending a possibly sensitive identifier to the model.
SPACE = r"[ \t\u00a0\u202f]"
DATE = r"(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}[ \t]+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)[ \t]+\d{4}(?:[ \t]+года)?)(?!\d)"
PHONE_SEP = r"[ \t\u00a0\u202f()\-–—]"
PATTERNS = {
    "EMAIL": r"(?<![\w.+-])[\w.+-]+@[\w.-]+\.[^\W\d_]{2,63}(?![\w-])",
    "OBFUSCATED_EMAIL": r"(?<!\w)[\w.+-]+[ \t]*\[at\][ \t]*[\w.-]+[ \t]*\[dot\][ \t]*[a-z]{2,63}(?!\w)",
    "PHONE": rf"(?<!\w)(?:\+7|8){PHONE_SEP}*\d{{3}}{PHONE_SEP}*\d{{3}}{PHONE_SEP}*\d{{2}}{PHONE_SEP}*\d{{2}}(?!\d)",
    "INTERNATIONAL_PHONE": rf"(?<!\w)\+\d(?:{PHONE_SEP}*\d){{7,14}}(?!\d)",
    "PHONE_EXTENSION": r"\b(?:доб[.]|добавочный)[ \t:]*\d{1,6}(?!\d)",
    "PASSPORT": rf"(?<!\d)(?:\d{{2}}{SPACE}?\d{{2}}{SPACE}+\d{{6}}|(?:серия|сер[.])[ \t:№]*\d{{2}}{SPACE}?\d{{2}}[ \t\r\n,;]*(?:номер|№)[ \t:№]*\d{{6}})(?!\d)",
    "PASSPORT_FIELD": r"\b(?:серия[ \t]+паспорта[ \t:№]*\d{4}|номер[ \t]+паспорта[ \t:№]*\d{6})(?!\d)",
    "SNILS": r"(?<!\d)\d{3}[- ]?\d{3}[- ]?\d{3}[- ]?\d{2}(?!\d)",
    "TAX_ID": r"(?<!\d)(?:\d{12}|\d{10}|\d{15})(?!\d)",
    "LABELED_TAX_ID": rf"\bИНН[ \t:№]*(?:\d{SPACE}*){{9,11}}\d(?!\d)",
    "BANK_ACCOUNT": r"(?<!\d)\d{5}(?:[ ]?\d){15}(?!\d)",
    "CARD": rf"\b(?:карта|номер[ \t]+карты)[ \t:№]*(?:\d{SPACE}*){{15,18}}\d(?!\d)",
    "URL": r"https?://[^\s<>\"']+",
    "IP_ADDRESS": r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)",
    # Issuance labels are intentionally conservative: other document issuance
    # dates may also be masked. Contract service deadlines are not date entities.
    "DOCUMENT_ISSUE_DATE": rf"\b(?:выдан|дата[ \t]+выдачи(?:[ \t]+паспорта)?(?:[ \t]+(?:заказчика|исполнителя|представителя))?)[ \t]*[:=]?[ \t]*{DATE}",
    "PASSPORT_ISSUER": rf"\bпаспорт[ \t]+выдан[ \t]+[^\n;!?]{{2,120}}?[ \t]+{DATE}",
    "ISSUER_CODE": r"\bкод[ \t]+подразделения[ \t:]*\d{3}[ -]?\d{3}(?!\d)",
    "BIRTH_DATE": rf"(?:дата[ ]+рождения(?:[ ]+(?:заказчика|исполнителя|представителя|гражданина|гражданки))?|родил[а-яё]*|д[.]?[ ]*р[.])[ ]*[:=]?[ ]*{DATE}",
    "BIRTH_YEAR": r"(?<!\d)\d{4}[ \t]+(?:года[ \t]+рождения|г[.][ \t]*р[.])",
    # Explicit labels allow lowercase names without broadly treating prose as names.
    "LABELED_PERSON": r"\b(?:ФИО(?:[ \t]+(?:заказчика|исполнителя|представителя))?|Customer)[ \t:—-]+[a-zа-яё]+(?:[-'][a-zа-яё]+)?(?:[ \t]+[a-zа-яё]+(?:[-'][a-zа-яё]+)?){1,2}(?!\w)",
    "INITIALS_PERSON": r"(?-i:[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?[ \t]+[А-ЯЁ][.][ \t]*[А-ЯЁ][.]|[А-ЯЁ][.][ \t]*[А-ЯЁ][.][ \t]+[А-ЯЁ][а-яё]+)",
    "QUOTED_ORGANIZATION": r"\b(?:ООО|АО|ПАО|ЗАО)[ \t]+[«\"][^»\"\n]{1,120}[»\"]",
    # Stop at sentence punctuation and explicit following field/contract labels.
    "ADDRESS": r"(?:адрес(?:[ ]+(?:регистрации|проживания|заказчика|исполнителя))?[ ]*:|прожива[а-яё]*[ ]+по[ ]+адресу|ул[.]|улица|проспект|пр-т|переулок|пер[.])[ \t]*(?:(?:\b(?:г|ул|д|кв|корп|стр|обл|пос|пер|просп|наб)[.])|(?!(?:стоимость|цена|срок|телефон|оплата|аванс|email)\b)[^.\n;!?])+",
}



def utf16_offset(text: str, offset: int) -> int:
    """Python counts code points; JavaScript slices UTF-16 code units."""
    return len(text[:offset].encode("utf-16-le")) // 2


def validate_texts(value):
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_TEXTS:
        raise ValueError("invalid_batch")
    if not all(isinstance(text, str) for text in value):
        raise ValueError("invalid_text")
    if sum(len(text.encode("utf-16-le")) // 2 for text in value) > MAX_CHARS:
        raise ValueError("batch_too_large")
    return value


class RussianDetector:
    def __init__(self):
        # Missing models/import errors fail startup; never silently use regex only.
        self.recognizers = [NatashaRussianRecognizer()] + [
            PatternRecognizer(
                supported_entity=entity,
                supported_language="ru",
                name=f"Criterion{entity}",
                patterns=[Pattern(name=entity, regex=pattern, score=0.8)],
            )
            for entity, pattern in PATTERNS.items()
        ]

    def detect(self, texts):
        validate_texts(texts)
        spans = []
        for text_index, text in enumerate(texts):
            if not text.strip():
                continue
            for recognizer in self.recognizers:
                for result in recognizer.analyze(
                    text=text,
                    entities=recognizer.supported_entities,
                    nlp_artifacts=None,
                ):
                    spans.append({
                        "textIndex": text_index,
                        "start": utf16_offset(text, result.start),
                        "end": utf16_offset(text, result.end),
                        "entityType": result.entity_type,
                    })
                    if len(spans) > MAX_SPANS:
                        raise ValueError("too_many_spans")
        # Overlap unions and mapping stay in the TypeScript request scope.
        return {"profile": PROFILE, "offsetUnit": "utf16", "spans": spans}
