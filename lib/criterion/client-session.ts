import { aiErrorCodes } from '../diagnostic-ai.mjs';
import { mailErrorCodes } from '../diagnostic-mail.mjs';
import { databaseErrorCodes } from '../diagnostic-storage.mjs';
import { paymentErrorCodes } from '../diagnostic-payment.mjs';

/** Only a known workspace document may be a sign-in return destination. */
export function workspaceReturnPath(value:string|null){
  if(!value?.startsWith('/')||value.startsWith('//')||/[\\\u0000-\u0020]/.test(value))return '/';
  try{
    const url=new URL(value,'https://criterion.invalid');
    if(url.origin!=='https://criterion.invalid'||url.pathname!=='/')return '/';
    const id=url.searchParams.get('document');
    if(!id||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))return '/';
    const payment=url.searchParams.get('payment');
    return '/?document='+id+(payment==='success'||payment==='fail'?'&payment='+payment:'');
  }catch{return '/'}
}
export function signInPath(returnTo:string){
  const path=workspaceReturnPath(returnTo);
  return path==='/'?'/auth':'/auth?return_to='+encodeURIComponent(path);
}

const operations = {
  auth:'Проверка аккаунта', login:'Вход в аккаунт', register:'Регистрация', logout:'Выход из аккаунта',
  recover:'Восстановление доступа', verify:'Подтверждение email', request_reset:'Запрос восстановления пароля', reset:'Смена пароля',
  workspace:'Загрузка рабочего пространства', open:'Открытие договора', create:'Создание договора', save:'Сохранение договора',
  generate:'Составление договора', review:'Проверка договора', revise:'Правка договора', message:'Интервью по договору',
  export:'Выгрузка договора', checkout:'Создание платежа', payment_status:'Проверка состояния оплаты', ui:'Работа интерфейса',
} as const;
export type ClientOperation = keyof typeof operations;
export const uncertainPayment = 'Не удалось получить окончательный результат оплаты. Состояние платежа уточняется. Повторно создавать платёж пока не требуется.';

const publicCodes = new Set([
  ...aiErrorCodes, ...mailErrorCodes, ...databaseErrorCodes, ...paymentErrorCodes,
  'BAD_REQUEST','UNAUTHORIZED','FORBIDDEN','NOT_FOUND','CONFLICT','METHOD_NOT_ALLOWED','PAYMENT_REQUIRED','PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE','RATE_LIMITED','UNAVAILABLE','VALIDATION_ERROR','REQUEST_TIMEOUT','DATABASE_ERROR','INTERNAL_ERROR',
  'AI_UNAVAILABLE','AI_NOT_CONFIGURED','AI_INVALID_RESPONSE','MAIL_SEND_FAILED','PRIVACY_ERROR','PAYMENT_ERROR','PAYMENT_UNAVAILABLE','BANK_REQUEST_REJECTED',
  ...['BANK_','GATEWAY_'].flatMap(prefix => ['DNS_ERROR','CONNECTION_REFUSED','CONNECT_TIMEOUT','TLS_ERROR','TIMEOUT','HTTP_ERROR',
    'RESPONSE_INVALID','NETWORK_ERROR','RESPONSE_INTERRUPTED'].map(suffix=>prefix+suffix)),
  'HTTP_ERROR','CLIENT_OFFLINE','CLIENT_NETWORK_ERROR','CLIENT_RESPONSE_INVALID','UI_EXCEPTION','UNSAVED_CHANGES',
]);
const knownCode = (value: unknown) => typeof value === 'string' && publicCodes.has(value) ? value : 'HTTP_ERROR';
const validRequestId = (value: unknown): value is string => typeof value === 'string' && value.length === 38 &&
  /^r_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly operation: ClientOperation;
  readonly occurredAt = new Date().toISOString();
  constructor(status: number, message: string, code?: unknown, operation: ClientOperation = 'ui', requestId?: unknown) {
    super(message);
    this.status = status;
    this.code = knownCode(code);
    this.requestId = validRequestId(requestId) ? requestId : undefined;
    this.operation = Object.hasOwn(operations, operation) ? operation : 'ui';
  }
}
export function asClientError(cause: unknown, operation: ClientOperation): ApiError {
  return cause instanceof ApiError ? cause : new ApiError(0,'В интерфейсе произошла ошибка. Обновите страницу.','UI_EXCEPTION',operation);
}
export function supportData(error: ApiError) {
  // Keep the original human message, URL, form values and stack outside the report.
  return [
    'Код ошибки: ' + knownCode(error.code),
    ...(validRequestId(error.requestId) ? ['Идентификатор запроса: ' + error.requestId] : []),
    'Время: ' + new Date(error.occurredAt).toISOString(),
    'Операция: ' + (Object.hasOwn(operations,error.operation) ? operations[error.operation] : operations.ui),
  ].join('\n');
}
export async function responseError(response: Response, operation: ClientOperation = 'ui') {
  let data: { error?: unknown; code?: unknown; requestId?: unknown } | null = null;
  try { data = await response.json(); } catch { /* HTTP failures may have a proxy HTML body. */ }
  const header = response.headers.get('X-Request-ID');
  const id = validRequestId(header) ? header : data?.requestId;
  let message = typeof data?.error === 'string' ? data.error : 'Сервер не смог выполнить запрос. Попробуйте позже.';
  if (response.status === 401 && !['login','recover','verify','reset'].includes(operation))
    message = 'Срок входа истёк. Войдите в аккаунт и повторите действие.';
  if (operation === 'payment_status' && response.status >= 500 && /^(BANK|GATEWAY)_/.test(knownCode(data?.code)))
    message = 'Не удалось проверить оплату. Попробуйте чуть позже.';
  if (data?.code === 'PAYMENT_CHECK_REQUIRED') message = 'Проверьте состояние платежа перед следующей попыткой.';
  return new ApiError(response.status,message,data?.code,operation,id);
}
export async function requestResponse(path: string, init: RequestInit, operation: ClientOperation): Promise<Response> {
  let response: Response;
  try { response = await fetch(path,init); }
  catch {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    throw new ApiError(0, offline ? 'Нет подключения к сети. Проверьте интернет-соединение.' : 'Не удалось получить ответ сервера. Проверьте соединение.',
      offline ? 'CLIENT_OFFLINE' : 'CLIENT_NETWORK_ERROR', operation);
  }
  if (!response.ok) throw await responseError(response,operation);
  return response;
}
export async function requestJson<T>(path: string, init: RequestInit, operation: ClientOperation, valid?: (value: unknown) => boolean): Promise<T> {
  const response = await requestResponse(path,init,operation);
  try {
    const value:unknown = await response.json();
    if (valid && !valid(value)) throw new Error('Unexpected response shape');
    return value as T;
  } catch { throw new ApiError(response.status,'Не удалось обработать ответ сервера. Обновите страницу и проверьте результат.',
    'CLIENT_RESPONSE_INVALID',operation,response.headers.get('X-Request-ID')); }
}
