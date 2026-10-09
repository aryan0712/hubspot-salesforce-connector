/**
 * Shared browser runtime, loaded first on every page (R11/R13):
 *  - unsafe same-origin requests echo the session's CSRF token (crm_csrf cookie) in the
 *    X-CSRF-Token header, which the server checks against the session;
 *  - a 401 (signed out, session expired or revoked) sends the browser to the sign-in page;
 *  - elements with data-action="fn" data-arg="x" call window.fn(x, element) on click, so
 *    pages need no inline event handlers (strict CSP: script-src 'self');
 *  - showError(message, requestId) / showNotice(message) render accessible inline messages
 *    (aria-live) instead of alert(); errors carry the request's correlation id.
 */
export const csrfFetchScript = String.raw`(()=>{
const nativeFetch=window.fetch.bind(window);
window.fetch=(input,init)=>{init=init||{};const method=String(init.method||'GET').toUpperCase();
if(method!=='GET'&&method!=='HEAD'){const m=document.cookie.match(/(?:^|; )crm_csrf=([^;]*)/);
if(m){const headers=new Headers(init.headers||{});headers.set('x-csrf-token',decodeURIComponent(m[1]));init=Object.assign({},init,{headers})}}
return nativeFetch(input,init).then((response)=>{if(response.status===401&&!location.pathname.startsWith('/auth/')){location.href='/auth/login'}return response})};
document.addEventListener('click',(event)=>{const el=event.target&&event.target.closest?event.target.closest('[data-action]'):null;if(!el)return;
const fn=window[el.getAttribute('data-action')];if(typeof fn==='function'){event.preventDefault();fn(el.getAttribute('data-arg'),el)}});
function region(){let r=document.getElementById('ui-messages');if(!r){r=document.createElement('div');r.id='ui-messages';r.className='ui-messages';
r.setAttribute('aria-live','polite');r.setAttribute('role','status');document.body.prepend(r)}return r}
function show(kind,message,requestId){const r=region();const box=document.createElement('div');box.className='ui-message ui-'+kind;
if(kind==='error'){box.setAttribute('role','alert')}const text=document.createElement('span');text.textContent=String(message||'Something went wrong.');box.appendChild(text);
if(requestId){const ref=document.createElement('small');ref.className='ui-ref';ref.textContent=' Reference: '+requestId;box.appendChild(ref)}
const close=document.createElement('button');close.type='button';close.className='ui-close';close.setAttribute('aria-label','Dismiss message');close.textContent='×';
close.addEventListener('click',()=>box.remove());box.appendChild(close);r.appendChild(box);
if(kind!=='error'){setTimeout(()=>box.remove(),8000)}return box}
window.showError=(message,requestId)=>show('error',message,requestId);
window.showNotice=(message)=>show('notice',message);
window.addEventListener('unhandledrejection',(event)=>{const reason=event.reason||{};show('error',reason.message||String(reason),reason.requestId)});
const style=document.createElement('style');style.textContent='.ui-messages{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:1000;display:grid;gap:8px;width:min(640px,calc(100vw - 32px))}'+
'.ui-message{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:10px;border:1px solid #263752;background:#101b2d;color:#edf4ff;box-shadow:0 8px 24px rgba(0,0,0,.35)}'+
'.ui-error{border-color:#7a2b3b;background:#3a1620}.ui-notice{border-color:#1c4b38;background:#0d281e;color:#d1fae5}.ui-notice span::before{content:"✓ ";font-weight:700;color:#34d399}.ui-ref{display:block;opacity:.75;margin-top:2px}.ui-message span{flex:1}'+
'.ui-close{background:transparent;border:0;color:inherit;font-size:18px;cursor:pointer;line-height:1;padding:0 4px}';
document.head.appendChild(style);
})();`;
