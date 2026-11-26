import { AppError } from './app-error.ts';
/**
 * Request-scoped, reversible pseudonymization. Only the trusted detector sees
 * source text. The vault is kept in this closure, never sent to the LLM.
 * Detector recall is a separate concern: this is not an anonymization guarantee.
 */
export type PiiSpan = {
  textIndex: number;
  start: number;
  end: number;
  entityType: string;
};
export type Detection = {
  profile: 'ru-contract-v1';
  offsetUnit: 'utf16';
  spans: PiiSpan[];
};
export type PiiDetector = (texts: readonly string[]) => Promise<Detection>;
export const PII_PREFIX = '[[CRITERION_PII_';
export const PII_INSTRUCTION =
  'Значения [[CRITERION_PII_...]] — защищённые обозначения. Копируй их целиком ' +
  'без изменения, склонения или расшифровки. Не придумывай скрытые сведения. ' +
  'Не определяй правовой статус стороны по обозначению PARTY. ' +
  'Ответ — JSON; имена свойств схемы сохраняй.';

const LIMITS = { strings: 4000, chars: 500_000, depth: 40, spans: 20_000 };
const WHOLE_FIELDS = new Set(['partyA', 'partyB', 'detailsA', 'detailsB']);
const FACT_KEYS = new Set(['partyA', 'partyB', 'subject', 'price', 'payment', 'term',
  'acceptance', 'liability', 'termination', 'city', 'date', 'detailsA', 'detailsB']);
// These are protocol identifiers owned by the application, not natural language.
// Running NER over camelCase keys can rename the JSON schema itself.
const SCHEMA_KEYS = new Set(['instruction', 'data', 'kind', 'allowedFields', 'facts',
  'messages', 'context', 'legalPackage', 'expectedSections', 'previousDocument',
  'requestedChange', 'materialInstructions', 'originalTemplate', 'candidateDraft',
  'sections', 'issues', 'id', 'title', 'content', 'text', 'role', 'at', 'key', 'label',
  'placeholder', 'group', 'severity', 'detail', 'sectionId', 'source', 'reply', 'ready',
  ...FACT_KEYS]);
function isProtocolValue(text: string, path: string[]) {
  const key = path.at(-1);
  return (key === 'kind' && ['services', 'sale', 'lease', 'work', 'nda', 'other'].includes(text)) ||
    (key === 'role' && ['user', 'assistant'].includes(text)) ||
    (key === 'severity' && ['high', 'medium', 'info'].includes(text)) ||
    (key === 'key' && path.at(-3) === 'allowedFields' && FACT_KEYS.has(text));
}
const hasReservedMarker = (text: string) =>
  text.replace(/[\s_\-\u200B-\u200D\uFEFF]/g, '').toUpperCase().includes('CRITERIONPII');
const own = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

export class PrivacyError extends AppError {
  constructor(cause?: unknown) {
    super({ code: 'PRIVACY_ERROR', status: 500, publicMessage: 'Обработка ПДн не завершена. Операция остановлена; результат не сохранён.',
      service: 'privacy', stage: 'privacy', retryable: false, cause });
    this.name = 'PrivacyError';
  }
}

function validText(text: string) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new PrivacyError();
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new PrivacyError();
    }
  }
}

// Visit values AND keys. Even user-controlled section ids/titles may contain PII.
// Undefined object properties follow JSON.stringify's omission semantics.
function mapStrings(
  value: unknown,
  visit: (text: string, path: string[], isKey: boolean) => string,
  path: string[] = [],
  ancestors = new Set<object>(),
  depth = 0,
): unknown {
  if (depth > LIMITS.depth) throw new PrivacyError();
  if (typeof value === 'string') return visit(value, path, false);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new PrivacyError();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, i) => mapStrings(item, visit, [...path, String(i)], ancestors, depth + 1));
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new PrivacyError();
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      const newKey = visit(key, [...path, key], true);
      if (own(result, newKey)) throw new PrivacyError();
      Object.defineProperty(result, newKey, {
        value: mapStrings(item, visit, [...path, key], ancestors, depth + 1),
        writable: true, enumerable: true, configurable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function isBoundary(text: string, offset: number) {
  const prev = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return !(prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

export async function protectRequest(
  input: { instruction: string; data: unknown },
  detect: PiiDetector,
): Promise<{ payload: { instruction: string; data: unknown }; restore: (value: unknown) => unknown }> {
  const texts: string[] = [];
  const protocolStrings = new Set<number>();
  const knownValues = new Set<string>();
  let chars = 0;
  mapStrings(input, (text, path, isKey) => {
    validText(text);
    if (hasReservedMarker(text)) throw new PrivacyError();
    chars += text.length;
    if (chars > LIMITS.chars || texts.length >= LIMITS.strings) throw new PrivacyError();
    if ((isKey && SCHEMA_KEYS.has(text)) || (!isKey && isProtocolValue(text, path))) {
      protocolStrings.add(texts.length);
    }
    texts.push(text);
    if (!isKey && path.at(-2) === 'facts' && WHOLE_FIELDS.has(path.at(-1)!) && text.trim()) {
      knownValues.add(text);
    }
    return text;
  });

  let detection: Detection;
  try {
    // A detector cannot change the texts which we later redact.
    detection = await detect(Object.freeze([...texts]));
  } catch (cause) {
    if (cause instanceof PrivacyError) throw cause;
    throw new PrivacyError(cause);
  }
  if (!detection || detection.profile !== 'ru-contract-v1' ||
      detection.offsetUnit !== 'utf16' || !Array.isArray(detection.spans) ||
      detection.spans.length > LIMITS.spans) throw new PrivacyError();

  const perText: PiiSpan[][] = texts.map(() => []);
  for (const span of detection.spans) {
    if (!span || !Number.isInteger(span.textIndex) || span.textIndex < 0 ||
        span.textIndex >= texts.length || !Number.isInteger(span.start) ||
        !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start ||
        span.end > texts[span.textIndex].length || typeof span.entityType !== 'string' ||
        !/^[A-Z][A-Z0-9_]{0,31}$/.test(span.entityType) ||
        !isBoundary(texts[span.textIndex], span.start) ||
        !isBoundary(texts[span.textIndex], span.end)) throw new PrivacyError();
    perText[span.textIndex].push({ ...span });
  }

  // Known party/requisite fields are protected regardless of NER confidence,
  // including their exact repetitions in messages, sources and templates.
  texts.forEach((text, textIndex) => {
    for (const value of knownValues) {
      let start = text.indexOf(value);
      while (start !== -1) {
        perText[textIndex].push({ textIndex, start, end: start + value.length, entityType: 'KNOWN' });
        if (perText[textIndex].length > LIMITS.spans) throw new PrivacyError();
        start = text.indexOf(value, start + value.length);
      }
    }
  });

  const scope = crypto.randomUUID().replaceAll('-', '');
  const originals = new Map<string, string>();
  const tokensByValue = new Map<string, string>();
  const sanitized = texts.map((text, textIndex) => {
    if (protocolStrings.has(textIndex)) return text;
    // Union overlapping spans; selecting one would leave part of a detected PII.
    const sorted = perText[textIndex].sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: PiiSpan[] = [];
    for (const span of sorted) {
      const last = merged.at(-1);
      if (last && span.start < last.end) {
        last.end = Math.max(last.end, span.end);
        if (last.entityType !== span.entityType) last.entityType = 'VALUE';
      } else {
        merged.push({ ...span });
      }
    }
    let result = '', from = 0;
    for (const span of merged) {
      const original = text.slice(span.start, span.end);
      let token = tokensByValue.get(original);
      if (!token) {
        token = PII_PREFIX + scope + '_' + span.entityType + '_' + (originals.size + 1) + ']]';
        originals.set(token, original);
        tokensByValue.set(original, token);
      }
      result += text.slice(from, span.start) + token;
      from = span.end;
    }
    return result + text.slice(from);
  });

  let index = 0;
  const payload = mapStrings(input, () => sanitized[index++]) as { instruction: string; data: unknown };
  // Do not expose the map or make a global cross-user registry.
  const restore = (value: unknown) => {
    let restoredChars = 0;
    return mapStrings(value, (text) => {
      validText(text);
      const pattern = /\[\[CRITERION_PII_[A-Za-z0-9_]+\]\]/g;
      const withoutTokens = text.replace(pattern, (token) => {
        if (!originals.has(token)) throw new PrivacyError();
        return '';
      });
      if (hasReservedMarker(withoutTokens)) throw new PrivacyError();
      // One pass only: restored source text is never interpreted as a new token.
      restoredChars += withoutTokens.length;
      if (restoredChars > LIMITS.chars * 4) throw new PrivacyError();
      return text.replace(pattern, (token) => {
        const original = originals.get(token)!;
        restoredChars += original.length;
        if (restoredChars > LIMITS.chars * 4) throw new PrivacyError();
        return original;
      });
    });
  };
  return { payload, restore };
}
