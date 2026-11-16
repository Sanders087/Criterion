"""Deterministic synthetic corpus. Gold labels authored independently of detector output."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# <<TYPE|sensitive value>> and <<KEEP|contract term that must stay visible>>.
# Never infer gold annotations from recognizer predictions.
CASES = r"""
name-full|Заказчик — <<PERSON|Иванов Иван Иванов>>. Цена <<KEEP|45 000 рублей>>.
name-female|Исполнитель — <<PERSON|Сидорова Анна Сергеевна>>.
name-genitive|Заявление от <<PERSON|Петрова Петра Петровича>> принято.
name-dative|Передать акт <<PERSON|Иванову Ивану Ивановичу>>.
name-instrumental|Согласовано с <<PERSON|Сидоровой Анной Сергеевной>>.
name-hyphen|Договор подписывает <<PERSON|Анна Смирнова-Петрова>>.
name-yo|Представитель — <<PERSON|Семён Фёдоров>>.
name-lower|ФИО заказчика: <<PERSON|иванов иван иванович>>.
name-initials|Заказчик: <<PERSON|Иванов И. И.>>.
name-initials-reverse|Подписант — <<PERSON|И. И. Иванов>>.
name-single|Контактное лицо: <<PERSON|Анна>>.
name-latin|Customer: <<PERSON|John Example>>.
email|Почта: <<EMAIL|ivanov@example.test>>.
email-plus|Отправить на <<EMAIL|contract+qa@example.test>>.
email-cyrillic|Адрес почты <<EMAIL|тест@пример.рф>>.
email-punctuation|Контакты: (<<EMAIL|person@example.test>>), срок <<KEEP|5 дней>>.
email-repeat|Email <<EMAIL|repeat@example.test>>. Дубликат: <<EMAIL|repeat@example.test>>.
email-upper|Почта <<EMAIL|PERSON@EXAMPLE.TEST>>.
email-obfuscated|Почта: <<EMAIL|person [at] example [dot] test>>.
phone-plus|Телефон <<PHONE|+7 (900) 111-22-33>>.
phone-eight|Телефон: <<PHONE|8 900 111 22 33>>.
phone-compact|Звонить <<PHONE|+79001112233>>.
phone-intl|Контакт: <<PHONE|+1 (202) 555-0147>>.
phone-nbsp|Телефон <<PHONE|+7 900 111 22 33>>.
phone-dash|Телефон <<PHONE|+7 (900) 111–22–33>>.
phone-local|Телефон: <<PHONE|9001112233>>.
phone-extension|Телефон <<PHONE|+7 (900) 111-22-33>>, добавочный <<PHONE|123>>.
passport-compact|Паспорт <<PASSPORT|4510 123456>>.
passport-split|Паспорт <<PASSPORT|45 10 123456>>.
passport-label|Паспорт: серия <<PASSPORT|4510>>, номер <<PASSPORT|123456>>.
passport-sign|Паспорт: серия <<PASSPORT|4510>> № <<PASSPORT|123456>>.
passport-short|Паспорт: сер. <<PASSPORT|4510>> № <<PASSPORT|123456>>.
passport-lines|Паспорт: серия <<PASSPORT|4510>>\nномер <<PASSPORT|123456>>.
passport-nospace|Паспорт <<PASSPORT|4510123456>>.
passport-isolated-series|Серия паспорта: <<PASSPORT|4510>>.
passport-isolated-number|Номер паспорта: <<PASSPORT|123456>>.
issue-date|Паспорт <<PASSPORT|4510 123456>>, выдан <<ISSUE_DATE|15.04.2016>>.
issue-label|Дата выдачи паспорта: <<ISSUE_DATE|15/04/2016>>.
issue-authority|Паспорт выдан <<ISSUER|ОВД Тестового района>> <<ISSUE_DATE|15.04.2016>>.
issue-code|Код подразделения: <<ISSUER_CODE|770-001>>.
issue-words|Паспорт выдан <<ISSUE_DATE|15 апреля 2016 года>>.
birth|Дата рождения: <<BIRTH_DATE|12.03.1990>>.
birth-party|Дата рождения заказчика: <<BIRTH_DATE|12-03-1990>>.
birth-short|Д. р. <<BIRTH_DATE|12.03.1990>>.
birth-year|<<BIRTH_DATE|1990>> года рождения.
birth-words|Родился <<BIRTH_DATE|12 марта 1990 года>>.
birth-iso|Дата рождения: <<BIRTH_DATE|1990-03-12>>.
snils|СНИЛС <<SNILS|123-456-789 00>>.
snils-compact|СНИЛС <<SNILS|12345678900>>.
snils-spaces|СНИЛС <<SNILS|123 456 789 00>>.
tax-person|ИНН <<TAX_ID|123456789012>>.
tax-company|ИНН <<TAX_ID|1234567890>>.
tax-spaces|ИНН: <<TAX_ID|1234 5678 9012>>.
account|Счёт <<BANK_ACCOUNT|40817810000012345678>>.
account-spaces|Счёт <<BANK_ACCOUNT|40817 810 0 0000 1234567>>.
card|Карта: <<CARD|2200 0000 0000 0004>>.
address-flat|Адрес: <<ADDRESS|г. Москва, ул. Тестовая, д. 15, кв. 42>>. Срок <<KEEP|5 дней>>.
address-street|Доставка: <<ADDRESS|ул. Учебная, д. 20, офис 305>>. Цена <<KEEP|5000 рублей>>.
address-postcode|Адрес: <<ADDRESS|123456, г. Москва, ул. Учебная, д. 8>>.
address-building|Адрес: <<ADDRESS|г. Казань, ул. Примерная, д. 2, корп. 3, кв. 4>>.
address-without-label|Посетить <<ADDRESS|ул. Тестовая, дом 7>>; стоимость <<KEEP|1500 рублей>>.
address-newline|Адрес: <<ADDRESS|г. Москва>>\n<<ADDRESS|ул. Учебная, д. 8>>.
address-slash|Адрес: <<ADDRESS|г. Москва, ул. Тестовая, д. 15/2, кв. 4>>.
address-no-punctuation|Адрес: <<ADDRESS|ул. Тестовая, д. 15>> стоимость <<KEEP|5000 рублей>>.
url|Профиль клиента: <<URL|https://example.test/users/ivanov?id=123>>.
ip|Адрес узла: <<IP_ADDRESS|192.0.2.10>>.
company|Исполнитель — <<ORGANIZATION|ООО «Тестовый пример»>>.
emoji|😀 Ответственный <<PERSON|Иван Иванов>>, почта <<EMAIL|emoji@example.test>>.
negative-money|Стоимость <<KEEP|45 000 рублей>>, аванс <<KEEP|50%>>, пеня <<KEEP|0,1%>>.
negative-dates|Срок услуг с <<KEEP|01.12.2026>> по <<KEEP|28.02.2027>>.
negative-hours|Время <<KEEP|09:00–18:00>>, прибытие за <<KEEP|4 часа>>.
negative-counts|Обслуживание <<KEEP|12 компьютеров>> и <<KEEP|2 принтеров>>.
negative-law|Применяется <<KEEP|статья 779 ГК РФ>>.
negative-version|Версия <<KEEP|1.11.0>>, задача <<KEEP|123456>>.
negative-price-long|Цена <<KEEP|1234567890 рублей>>.
negative-account-word|Выставить <<KEEP|счёт на 5000 рублей>> до конца месяца.
negative-address-word|Уточнить <<KEEP|адрес доставки>> до начала работ.
negative-street-word|Требуется <<KEEP|уборка улиц>> два раза в неделю.
negative-date-delivery|Дата выдачи результата: <<KEEP|15.04.2027>>.
negative-passport-word|<<KEEP|Паспортные данные будут предоставлены позднее>>.
"""
# These families deliberately probe unsupported/ambiguous formats. They remain
# in totals and failures; they are NOT converted into passes or discarded.
CHALLENGE = set('name-lower name-initials name-initials-reverse name-single name-latin email-obfuscated phone-extension issue-authority issue-words birth-year birth-words address-no-punctuation negative-price-long'.split())


def units(text):
    return len(text.encode('utf-16-le')) // 2


def parse(markup):
    markup = markup.replace('\\n', '\n').replace('\\u00a0', '\u00a0')
    text, spans, keep, end = '', [], [], 0
    for match in re.finditer(r'<<([A-Z_]+)\|([^<>]+)>>', markup):
        text += markup[end:match.start()]
        kind, value = match.groups()
        span = {'start': units(text), 'end': units(text + value), 'text': value}
        if kind == 'KEEP':
            keep.append(span)
        else:
            spans.append({**span, 'entityType': kind})
        text += value
        end = match.end()
    text += markup[end:]
    assert '<<' not in text and '>>' not in text
    return {'text': text, 'sensitive': spans, 'keep': keep}


def main():
    templates = [line.split('|', 1) for line in CASES.strip().splitlines()]
    rows = []
    for family, markup in templates:
        for variant, (prefix, suffix) in enumerate([
            ('', ''), ('Условия договора услуг. ', ' Приёмка за <<KEEP|5 рабочих дней>>.'),
            ('😀 Анкета клиента:\n', '\nСтоимость <<KEEP|45 000 рублей>>.')
        ]):
            rows.append({'id': f'{family}-{variant}', 'family': family,
                         'suite': 'challenge' if family in CHALLENGE else 'core',
                         **parse(prefix + markup + suffix)})
    # Composite documents independently combine labeled fields and ordinary terms.
    # All source templates and composites stay visible; no claimed holdout split.
    for i in range(100):
        picked = [templates[(i * 7 + j * 11) % len(templates)] for j in range(6)]
        rows.append({'id': f'composite-{i:03}', 'family': 'composite',
                     'suite': 'challenge' if any(f in CHALLENGE for f, _ in picked) else 'core',
                     **parse('\n'.join(m for _, m in picked))})
    target = ROOT / 'tests/fixtures/pii-corpus.jsonl'
    target.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows), encoding='utf-8', newline='\n')
    print(json.dumps({'cases': len(rows), 'sourceTemplates': len(templates),
                      'sensitiveSpans': sum(len(r['sensitive']) for r in rows),
                      'keepSpans': sum(len(r['keep']) for r in rows)}))


if __name__ == '__main__':
    main()
