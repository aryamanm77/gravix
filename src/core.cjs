const fs = require('node:fs');
const path = require('node:path');

/**
 * @typedef {Object} Token
 * @property {string} accessToken
 * @property {string} [refreshToken]
 * @property {number} expiryDateSeconds - Unix timestamp in seconds
 * @property {string} [tokenType]
 * @property {boolean} [isGcpTos]
 */

/**
 * @typedef {Object} Model
 * @property {string} id
 * @property {string} label
 * @property {number|null} fraction - 0–1 quota remaining, or null if unknown
 * @property {string|null} resetTime - ISO date string or null
 * @property {string} checkedAt - ISO date string
 * @property {'available'|'exhausted'|'unknown'} status
 */

/**
 * @typedef {Object} Account
 * @property {string} id
 * @property {string} email
 * @property {string} name
 * @property {string} [tier]
 * @property {Token} token
 * @property {Model[]} models
 * @property {string} [checkedAt]
 * @property {string} [error]
 * @property {string} [lastQuotaAttemptAt]
 * @property {Object} [quotaCache]
 */

/**
 * @typedef {Object} Config
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {string[]} scopes
 * @property {string} version
 * @property {string} [cloudCodeUrl]
 */

// These are implementation details of the installed IDE, not a public API.
/**
 * Reads OAuth config from IDE's main.js.
 * @param {string} appRoot
 * @returns {Config}
 */
function installedConfig(appRoot) {
  const source = fs.readFileSync(path.join(appRoot, 'out', 'main.js'), 'utf8');
  const block = source.match(/common\/oauthClient\.js[\s\S]{0,2400}/)?.[0];
  const clientId = block?.match(/"([\w-]+\.apps\.googleusercontent\.com)"/)?.[1];
  const clientSecret = block?.match(/"(GOCSPX-[\w-]+)"/)?.[1];
  const scopes = [...(block || '').matchAll(/"(https:\/\/www\.googleapis\.com\/auth\/[\w.-]+)"/g)].map(m => m[1]);
  if (!clientId || !clientSecret || !scopes.length) throw new Error('This IDE build has an unrecognized OAuth configuration. Integration needs updating.');
  const product = JSON.parse(fs.readFileSync(path.join(appRoot, 'product.json'), 'utf8'));
  return { clientId, clientSecret, scopes: [...new Set(scopes)], version: product.ideVersion || product.version };
}

/**
 * Performs a JSON HTTP request with timeout.
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 * @throws {Error}
 */
async function jsonRequest(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) }); }
  catch { throw new Error('Network request failed or timed out.'); }
  // Never return OAuth responses, error bodies or request headers to the UI/logs.
  if (!response.ok) {
    const error = new Error(response.status === 401 ? 'Sign-in expired; reconnect this account.' : `Service returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  try { return await response.json(); }
  catch { throw new Error('Service returned an invalid JSON response.'); }
}

/**
 * Refreshes an OAuth token if it is nearing expiry.
 * @param {Token} token
 * @param {Config} config
 * @returns {Promise<Token>}
 */
async function refreshToken(token, config) {
  if (token.accessToken && token.expiryDateSeconds * 1000 > Date.now() + 60000) return token;
  if (!token.refreshToken) throw new Error('This account needs to sign in again.');
  const result = await jsonRequest('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
      grant_type: 'refresh_token', refresh_token: token.refreshToken })
  });
  if (!result.access_token || !Number.isFinite(result.expires_in)) throw new Error('Google did not return a valid access token.');
  return { ...token, accessToken: result.access_token, refreshToken: result.refresh_token || token.refreshToken,
    expiryDateSeconds: Math.floor(Date.now() / 1000) + result.expires_in, tokenType: result.token_type || 'Bearer' };
}

/**
 * Fetches Google user profile info.
 * @param {Token} token
 * @returns {Promise<{id: string, email: string, name: string}>}
 */
async function profile(token) {
  const result = await jsonRequest('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${token.accessToken}` }
  });
  if (!result.id || !result.email) throw new Error('Google did not return an account identity.');
  return { id: result.id, email: result.email, name: result.name || result.email };
}

/**
 * Normalizes model catalog response into Model array.
 * @private
 * @param {Object} response
 * @param {string} [checkedAt]
 * @returns {Model[]}
 */
function normalizeModels(response, checkedAt = new Date().toISOString()) {
  if (!response.models || typeof response.models !== 'object' || Array.isArray(response.models)) {
    throw new Error('Unrecognized model response. Integration needs updating.');
  }
  const agentIds = Array.isArray(response.agentModelSorts)
    ? new Set(response.agentModelSorts.flatMap(sort => (sort.groups || []).flatMap(group => group.modelIds || []))) : null;
  return Object.entries(response.models).filter(([id, model]) => {
    if (!model || typeof model !== 'object') throw new Error('Unrecognized model entry. Integration needs updating.');
    return !model.disabled && !model.isInternal && (!agentIds || agentIds.has(id));
  }).map(([id, model]) => {
    if (!model || typeof model !== 'object') throw new Error('Unrecognized model entry. Integration needs updating.');
    const hasQuota = model.quotaInfo !== null && typeof model.quotaInfo === 'object' && !Array.isArray(model.quotaInfo);
    const q = hasQuota ? model.quotaInfo : {};
    // QuotaInfo.remaining_fraction is an implicit-presence proto3 double in the
    // installed model_configs.proto. JSON omits it when zero. Absence of the
    // entire quotaInfo message, however, does not establish any quota value.
    const value = hasQuota && !Object.hasOwn(q, 'remainingFraction') ? 0 : q.remainingFraction;
    const fraction = typeof value === 'number' && Number.isFinite(value)
      && value >= 0 && value <= 1 ? value : null;
    const resetTime = typeof q.resetTime === 'string' && Number.isFinite(Date.parse(q.resetTime)) ? q.resetTime : null;
    return { id, label: model.displayName || model.label || id, fraction, resetTime, checkedAt,
      status: fraction === null ? 'unknown' : fraction > 0 ? 'available' : 'exhausted' };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Computes model availability display status based on time and status.
 * @param {Model} model
 * @param {number} [now]
 * @returns {'available'|'exhausted'|'stale'|'recheck'|'unknown'}
 */
function availability(model, now = Date.now()) {
  if (model.status === 'exhausted' && model.resetTime && Date.parse(model.resetTime) <= now
    && Date.parse(model.checkedAt) < Date.parse(model.resetTime)) return 'recheck';
  if (now - Date.parse(model.checkedAt) > 5 * 60000) return 'stale';
  return model.status;
}

/**
 * Validates and returns the origin for Cloud Code service URL.
 * @param {Config} config
 * @returns {string}
 * @throws {Error}
 */
function cloudCodeBase(config) {
  const url = new URL(config.cloudCodeUrl || 'https://cloudcode-pa.googleapis.com');
  if (url.protocol !== 'https:' || !/^(?:[a-z0-9-]+-)?cloudcode-pa\.googleapis\.com$/.test(url.hostname)
    || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The IDE reported an unrecognized Cloud Code service URL. Integration needs updating.');
  }
  return url.origin;
}

/**
 * Checks whether an account has any exhausted model whose reset time has passed.
 * @param {Account} account
 * @param {number} [now]
 * @returns {boolean}
 */
function resetDue(account, now = Date.now()) {
  if (account.error && now - Date.parse(account.lastQuotaAttemptAt) < 2 * 60000) return false;
  return (account.models || []).some(model => model.status === 'exhausted' && model.resetTime
    && Date.parse(model.resetTime) <= now
    && (account.error || !Number.isFinite(Date.parse(model.checkedAt)) || Date.parse(model.checkedAt) < Date.parse(model.resetTime)
      || now - Date.parse(model.checkedAt) >= 5 * 60000));
}

/**
 * Fetches quota data and paid tier information for an account.
 * @param {Token} token
 * @param {Config} config
 * @param {Object} [cache]
 * @returns {Promise<{models: Model[], tier: string}>}
 */
async function quotas(token, config, cache) {
  const { catalog, info } = await accountData(token, config, false, cache);
  return { models: normalizeModels(catalog), tier: info.paidTier?.name || info.currentTier?.name || info.paidTier?.id || info.currentTier?.id || 'Unknown plan' };
}

/**
 * Internal loader for account models, tier, and user settings.
 * @private
 * @param {Token} token
 * @param {Config} config
 * @param {boolean} [includeSettings=false]
 * @param {Object} [cache]
 * @returns {Promise<{catalog: Object, info: Object, settings: Object}>}
 */
async function accountData(token, config, includeSettings = false, cache) {
  if (token.isGcpTos) throw new Error('Only personal Google accounts are supported.');
  const base = cloudCodeBase(config);
  const post = (method, body) => jsonRequest(`${base}/v1internal:${method}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json',
      'User-Agent': `antigravity/${config.version} windows/x64` }, body: JSON.stringify(body)
  });
  const cached = cache?.project && Date.now() - cache.updatedAt < 15 * 60000;
  const info = cached ? cache.info : await post('loadCodeAssist', { metadata: { ideName: 'antigravity', ideType: 'ANTIGRAVITY', ideVersion: config.version } });
  const project = cached ? cache.project : typeof info.cloudaicompanionProject === 'string' ? info.cloudaicompanionProject : info.cloudaicompanionProject?.id;
  if (!project) throw new Error('No Antigravity project found. Complete onboarding in the IDE for this account first.');
  let catalog;
  try { catalog = await post('fetchAvailableModels', { project }); }
  catch (error) {
    if (cached && [403, 404].includes(error.status)) { cache.updatedAt = 0; return accountData(token, config, includeSettings, cache); }
    throw error;
  }
  if (cache && !cached) Object.assign(cache, { project, info, updatedAt: Date.now() });
  const settings = includeSettings ? (await post('fetchUserInfo', { project })).userSettings || {} : {};
  return { catalog, info, settings };
}

module.exports = { installedConfig, jsonRequest, refreshToken, profile, quotas, accountData, normalizeModels, availability, resetDue, cloudCodeBase };
