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
export class ApiError extends Error{
  status:number;
  readonly code?:string;
  constructor(status:number,message:string,code?:string){super(message);this.status=status;this.code=code}
}
export async function responseError(response:Response){
  let message='Не удалось выполнить действие. Попробуйте ещё раз.';
  let code:string|undefined;
  try{const data=await response.json() as {error?:unknown;code?:unknown}|null;if(typeof data?.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(data.code))code=data.code;if(typeof data?.error==='string')message=data.error}catch{}
  if(response.status===401)message='Срок входа истёк. Войдите в аккаунт и повторите действие.';
  return new ApiError(response.status,message,code);
}
