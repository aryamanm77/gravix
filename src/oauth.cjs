const http = require('node:http');
const { randomBytes, createHash } = require('node:crypto');
const { jsonRequest } = require('./core.cjs');

async function signIn(config, openExternal, cancellation, options = {}) {
  const state = randomBytes(32).toString('hex');
  const verifier = randomBytes(48).toString('base64url');
  let complete, fail;
  const codePromise = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  // Attach immediately so cancellation during browser launch is handled.
  codePromise.catch(() => {});
  function callbackPage(message, isError = false) {
    const nonce = randomBytes(18).toString('base64');
    const windowTitle = `Antigravity OAuth ${randomBytes(8).toString('hex')}`;
    const autoClose = !!options.closeWindow;
    const accentColor = isError ? '#ff4757' : '#ff6b35';
    const statusColor = isError ? '#ff4757' : '#00f5d4';
    const heading = isError ? 'Authentication Failed' : 'Authentication Complete';
    const subText = isError ? 'Google sign-in could not be completed.' : 'Your Google account has been connected to Gravix.';
    const badgeText = isError ? '✕ Sign-in interrupted' : '✓ Synced with Antigravity IDE';

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${windowTitle}</title>
<style nonce="${nonce}">
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: radial-gradient(circle at 50% 20%, #20133b 0%, #0d081e 65%, #07040f 100%);
    color: #f3effc;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    padding: 24px;
  }
  .card, .shell {
    width: min(440px, 100%);
    background: rgba(26, 19, 52, 0.82);
    border: 1px solid rgba(157, 78, 221, 0.35);
    border-radius: 20px;
    padding: 38px 32px 32px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.65), 0 0 40px rgba(157, 78, 221, 0.18);
    backdrop-filter: blur(16px);
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .card::before, .shell::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0; height: 3px;
    background: linear-gradient(90deg, #ff6b35 0%, #d83a7d 50%, #9d4edd 100%);
  }
  .logo-wrap {
    width: 68px; height: 68px;
    margin: 0 auto 20px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(255, 107, 53, 0.22), rgba(157, 78, 221, 0.22));
    border: 1px solid rgba(157, 78, 221, 0.45);
    display: grid; place-items: center;
    box-shadow: 0 0 28px rgba(255, 107, 53, 0.3);
  }
  .logo-wrap svg { width: 36px; height: 36px; }
  h1 {
    font-size: 22px;
    font-weight: 700;
    margin-bottom: 8px;
    letter-spacing: -0.01em;
    background: linear-gradient(135deg, #ffffff 40%, #c77dff 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .sub {
    font-size: 13px;
    color: #a498c4;
    line-height: 1.5;
    margin-bottom: 20px;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 6px 14px;
    border-radius: 999px;
    background: rgba(0, 245, 212, 0.1);
    border: 1px solid rgba(0, 245, 212, 0.35);
    color: ${statusColor};
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 24px;
  }
  .badge-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: ${statusColor};
    box-shadow: 0 0 8px ${statusColor};
  }
  .btn {
    width: 100%;
    padding: 12px 20px;
    border: none;
    border-radius: 10px;
    background: linear-gradient(135deg, #ff6b35 0%, #b5179e 50%, #7209b7 100%);
    color: #ffffff;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 8px 24px rgba(181, 23, 158, 0.35);
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 28px rgba(181, 23, 158, 0.45);
  }
  .btn:active {
    transform: translateY(0);
  }
  .hint {
    margin-top: 18px;
    font-size: 12px;
    color: #7b6f99;
  }
</style>
</head>
<body>
  <main class="shell">
    <div class="logo-wrap">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18.5 8.5A7.5 7.5 0 1 0 19 14h-6v-3h6" stroke="#ff8c42"/>
        <circle cx="5" cy="8" r="1.5" fill="#ff6b35"/>
        <circle cx="18" cy="18" r="1.5" fill="#c77dff"/>
        <path d="M3.5 12a8.8 8.8 0 0 0 2 5.5" stroke="#9d4edd"/>
      </svg>
    </div>
    <h1>${heading}</h1>
    <p class="sub">${message || subText}</p>
    <div class="badge"><span class="badge-dot"></span> ${badgeText}</div>
    <button id="close" class="btn" type="button">Close this tab</button>
    <p class="hint">You can safely close this window and return to Antigravity IDE.</p>
  </main>
  <script nonce="${nonce}">
    document.getElementById('close').addEventListener('click', () => window.close());
    ${autoClose ? 'setTimeout(() => window.close(), 150);' : ''}
  </script>
</body>
</html>`;
    return { nonce, windowTitle, html };
  }
  function respond(res, message, isError = false) {
    const page = callbackPage(message, isError);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${page.nonce}'; style-src 'nonce-${page.nonce}'`);
    res.end(page.html);
    return options.onCloseWindow?.(page.windowTitle);
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' || url.pathname !== '/oauth-callback') { res.writeHead(404).end(); return; }
    if (url.searchParams.get('state') !== state) { res.writeHead(400).end('Invalid sign-in state.'); return; }
    if (url.searchParams.has('error')) {
      Promise.resolve(respond(res, 'Sign-in was cancelled.', true)).catch(() => {}).finally(() => fail(new Error('Google sign-in was cancelled.'))); return;
    }
    const code = url.searchParams.get('code');
    if (!code) { res.writeHead(400).end('Missing authorization code.'); return; }
    Promise.resolve(respond(res, options.closeWindow ? 'Sign-in received. This window will close automatically.' : 'Sign-in received. Return to Gravix to continue.'))
      .catch(() => {}).finally(() => complete(code));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const redirect = `http://localhost:${server.address().port}/oauth-callback`;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 180000;
  const timer = setTimeout(() => fail(new Error('Sign-in timed out. Please try again.')), timeoutMs);
  const subscription = cancellation?.onCancellationRequested(() => fail(new Error('Sign-in cancelled.')));
  try {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    const parameters = { client_id: config.clientId, redirect_uri: redirect, response_type: 'code',
      scope: config.scopes.join(' '), access_type: 'offline', prompt: options.selectAccount === false ? 'consent' : 'consent select_account', state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' };
    if (options.loginHint) parameters.login_hint = options.loginHint;
    url.search = new URLSearchParams(parameters).toString();
    if (!await openExternal(url.toString())) throw new Error('Could not open the sign-in browser.');
    const code = await codePromise;
    const result = await jsonRequest('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
      client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirect,
      grant_type: 'authorization_code', code_verifier: verifier
    }) });
    if (!result.access_token || !result.refresh_token || !Number.isFinite(result.expires_in)) throw new Error('Google did not provide a persistent sign-in. Try reconnecting.');
    return { accessToken: result.access_token, refreshToken: result.refresh_token,
      expiryDateSeconds: Math.floor(Date.now() / 1000) + result.expires_in, tokenType: result.token_type || 'Bearer', isGcpTos: false };
  } finally { clearTimeout(timer); subscription?.dispose(); server.closeAllConnections(); server.close(); }
}
module.exports = { signIn };
