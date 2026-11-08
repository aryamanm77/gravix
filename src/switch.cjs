const core = require('./core.cjs');
const { userStatusJson, pushStatus } = require('./ide-state.cjs');

/**
 * Prepares the target account session by refreshing token, verifying identity, and encoding profile.
 * @param {import('./core.cjs').Token} token
 * @param {import('./core.cjs').Config} config
 * @param {Object} codec
 * @param {string} [expectedId]
 * @returns {Promise<{token: import('./core.cjs').Token, status: string, identity: {id: string, email: string, name: string}}>}
 * @throws {Error}
 */
async function prepare(token, config, codec, expectedId) {
  const refreshed = await core.refreshToken(token, config);
  const identity = await core.profile(refreshed);
  if (expectedId && identity.id !== expectedId) throw new Error('Account identity did not match. Switch cancelled.');
  const { catalog, info, settings } = await core.accountData(refreshed, config, true);
  const status = codec.encode(userStatusJson(catalog, settings, identity, info.paidTier));
  if (codec.decode(status).email !== identity.email) throw new Error('Could not prepare the account profile.');
  return { token: refreshed, status, identity };
}

/**
 * Captures current IDE session token and status for rollback.
 * @param {Object} api
 * @returns {Promise<{token: import('./core.cjs').Token, status: string}>}
 * @throws {Error}
 */
async function capture(api) {
  const token = await api.OAuthPreferences.getOAuthTokenInfo();
  const status = await api.UserStatus.getUserStatus();
  if (!token?.accessToken || !status) throw new Error('Sign into the IDE before switching so its complete session can be restored.');
  return { token, status };
}

/**
 * Applies a target session to the IDE and restarts the language server.
 * @param {Object} params
 * @param {Object} params.api
 * @param {Object} params.commands
 * @param {Object} params.codec
 * @param {Object} params.target
 * @param {Function} [params.sleep]
 * @returns {Promise<void>}
 * @throws {Error}
 */
async function applySession({ api, commands, codec, target, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  await api.OAuthPreferences.setOAuthTokenInfo(target.token);
  // The auth provider builds its session from both token AND UserStatus. Do not
  // clear the profile: doing so makes handleAuthRefresh return no session.
  await pushStatus(api, target.status);
  for (let attempt = 0; attempt < 30; attempt++) {
    const token = await api.OAuthPreferences.getOAuthTokenInfo();
    const status = await api.UserStatus.getUserStatus();
    if (token?.accessToken === target.token.accessToken && status && codec.decode(status).email === target.identity.email) break;
    if (attempt === 29) throw new Error('The IDE did not synchronize the selected account.');
    await sleep(100);
  }
  await commands.executeCommand('antigravity.handleAuthRefresh');
  await commands.executeCommand('antigravity.restartLanguageServer');
  const token = await api.OAuthPreferences.getOAuthTokenInfo();
  const status = codec.decode(await api.UserStatus.getUserStatus());
  if (token?.accessToken !== target.token.accessToken || status.email !== target.identity.email) {
    throw new Error('Account verification failed after restarting the language server.');
  }
}

/**
 * Switches the IDE session with rollback protection if the switch fails.
 * @param {Object} params
 * @param {Object} params.api
 * @param {Object} params.commands
 * @param {Object} params.codec
 * @param {Object} params.target
 * @param {Function} params.saveRollback
 * @param {Function} [params.sleep]
 * @returns {Promise<void>}
 * @throws {Error}
 */
async function switchSession({ api, commands, codec, target, saveRollback, sleep }) {
  const previous = await capture(api);
  await saveRollback(previous);
  try {
    await applySession({ api, commands, codec, target, sleep });
  } catch (error) {
    try {
      await applySession({ api, commands, codec, target: { ...previous, identity: { email: codec.decode(previous.status).email } }, sleep });
    } catch {
      throw new Error('Switch failed and automatic restoration could not be verified. Use Restore previous session or sign in through the IDE.');
    }
    throw new Error('Switch failed; the previous account and profile were restored.');
  }
}
module.exports = { prepare, capture, applySession, switchSession };
