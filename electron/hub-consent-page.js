function applyTheme(theme) { document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'; }
applyTheme(window.hubConsent.theme);
const removeThemeListener = window.hubConsent.onTheme(applyTheme);
window.addEventListener('unload', removeThemeListener, { once: true });
const allow = document.getElementById('allow');
const cancel = document.getElementById('cancel');
const close = document.getElementById('close');
let valid = false;
function decide(approved) {
  if (approved && !valid) return;
  valid = false; allow.disabled = true; cancel.disabled = true;
  window.hubConsent.decide(approved);
}
allow.addEventListener('click', () => decide(true));
cancel.addEventListener('click', () => decide(false));
close.addEventListener('click', () => decide(false));
document.addEventListener('keydown', event => { if (event.key === 'Escape') decide(false); });
window.hubConsent.read().then(data => {
  if (!data || Date.now() >= data.expiresAt) throw new Error('授权请求已过期，请从项目广场重新登录。');
  applyTheme(data.theme);
  const [name, ...email] = data.account.split(' · ');
  document.getElementById('account-name').textContent = name;
  document.getElementById('account-email').textContent = email.join(' · ');
  document.getElementById('account-avatar').textContent = Array.from(name)[0] || 'A';
  document.getElementById('target-origin').textContent = data.origin;
  document.getElementById('account-site').textContent = data.region === 'cn' ? '国内站账号' : data.region === 'intl' ? '国际站账号' : '当前账号';
  valid = true; allow.disabled = false;
}).catch(() => {
  const error = document.getElementById('error');
  error.textContent = '授权请求已过期或无法读取，请从项目广场重新登录。'; error.hidden = false;
});
