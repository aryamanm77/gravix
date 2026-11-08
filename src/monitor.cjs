const net = require('node:net');

// Hold a lease for one check/prompt only. A background window must never retain
// ownership and prevent the focused window from delivering notifications.
/**
 * Tries to acquire a single-instance lease via local port binding.
 * @private
 * @returns {Promise<(() => void)|null>}
 */
async function acquireLease() {
  const server = net.createServer(socket => socket.destroy());
  const acquired = await new Promise(resolve => {
    server.once('error', () => resolve(false));
    server.listen(43129, '127.0.0.1', () => resolve(true));
  });
  if (!acquired) return null;
  server.unref();
  return () => server.close();
}

/**
 * Checks if a specific model on an account is exhausted.
 * @param {import('./core.cjs').Account} account
 * @param {string} modelId
 * @returns {boolean}
 */
function exhausted(account, modelId) {
  const model = account?.models?.find(m => m.id === modelId);
  return !account?.error && model?.fraction === 0;
}

/**
 * Checks if a specific model on an account has quota available.
 * @param {import('./core.cjs').Account} account
 * @param {string} modelId
 * @returns {boolean}
 */
function available(account, modelId) {
  const model = account?.models?.find(m => m.id === modelId);
  return !account?.error && typeof model?.fraction === 'number' && model.fraction > 0;
}

/**
 * Returns alternative accounts ordered from activeId, wrapping around.
 * @param {import('./core.cjs').Account[]} accounts
 * @param {string} activeId
 * @returns {import('./core.cjs').Account[]}
 */
function nextAccounts(accounts, activeId) {
  const index = accounts.findIndex(a => a.id === activeId);
  if (index < 0) return [];
  return [...accounts.slice(index + 1), ...accounts.slice(0, index)];
}

/**
 * Manages periodic quota polling, exhaustion detection, and switch proposals.
 */
class QuotaMonitor {
  /**
   * @param {Object} deps
   * @param {() => {enabled: boolean, modelId: string, revision: number}} deps.config
   * @param {() => import('./core.cjs').Account[]} deps.accounts
   * @param {() => Promise<import('./core.cjs').Account|undefined>} deps.activeAccount
   * @param {() => boolean} deps.isBusy
   * @param {() => boolean} [deps.isFocused]
   * @param {() => number} [deps.batchSize]
   * @param {(account: import('./core.cjs').Account) => Promise<void>} deps.check
   * @param {(accounts: import('./core.cjs').Account[]) => Promise<void>} [deps.checkMany]
   * @param {(status: string) => void} deps.status
   * @param {(active: import('./core.cjs').Account, next: import('./core.cjs').Account, modelId: string) => Promise<string>} deps.ask
   * @param {() => Promise<void>} deps.stop
   * @param {(account: import('./core.cjs').Account) => Promise<void>} deps.switchAccount
   * @param {() => Promise<(() => void)|null>} [deps.acquireLease]
   * @param {() => number} [deps.now]
   */
  constructor(deps) {
    this.d = deps;
    this.running = false;
    this.cooldowns = new Map();
    this.backoffMap = new Map();
    this.now = deps.now || Date.now;
  }

  /**
   * Runs a single monitoring tick to check active account quota and find alternatives if exhausted.
   * @returns {Promise<void>}
   */
  async tick() {
    if (this.running || this.d.isBusy() || this.d.isFocused?.() === false) return;
    const config = { ...this.d.config() };
    if (!config.enabled || !config.modelId) { this.releaseLease(); return; }
    this.running = true;
    try {
      this.release ||= await (this.d.acquireLease || acquireLease)();
      if (!this.release) { this.d.status('Another window is finishing a check. Retrying shortly.'); return; }
      const stillEnabled = () => { const c = this.d.config(); return this.d.isFocused?.() !== false && c.enabled && c.modelId === config.modelId && c.revision === config.revision; };
      const active = await this.d.activeAccount();
      if (!active) { this.d.status('Save the active IDE account to monitor its quota.'); return; }
      const key = `${active.id}:${config.modelId}`;
      if ((this.cooldowns.get(key) || 0) > this.now()) return;
      this.d.status('Checking the active account…');
      await this.d.check(active);
      if (!stillEnabled()) return;
      if (active.error) { this.d.status('Quota check failed; retrying in 20 seconds.'); return; }
      if (!active.models.some(m => m.id === config.modelId)) { this.d.status('This model is not reported for the active account.'); return; }
      if (!exhausted(active, config.modelId)) {
        this.cooldowns.delete(key);
        this.backoffMap.delete(key);
        this.d.status(available(active, config.modelId) ? 'Watching active account · checks every 20s' : 'Quota unknown; retrying in 20 seconds.'); return;
      }
      this.d.status('Quota exhausted. Looking for the next account…');
      let candidate;
      const alternatives = nextAccounts(this.d.accounts(), active.id);
      const batchSize = typeof this.d.batchSize === 'function' ? Math.max(1, Math.min(10, this.d.batchSize() | 0)) : 5;
      for (let offset = 0; offset < alternatives.length; offset += batchSize) {
        if (!stillEnabled() || this.d.isBusy()) return;
        const batch = alternatives.slice(offset, offset + batchSize);
        if (this.d.checkMany) await this.d.checkMany(batch);
        else for (const account of batch) await this.d.check(account);
        candidate = batch.find(account => available(account, config.modelId));
        if (candidate) break;
      }
      if (!stillEnabled()) return;
      if (!candidate) {
        const backoffStep = this.backoffMap.get(key) || 0;
        const backoffMs = Math.min(5 * 60000 * Math.pow(2, backoffStep), 30 * 60000);
        this.backoffMap.set(key, backoffStep + 1);
        this.cooldowns.set(key, this.now() + backoffMs);
        const backoffMinutes = Math.round(backoffMs / 60000);
        this.d.status(`No other account has confirmed quota. Checking again in ${backoffMinutes} min.`); return;
      }
      if ((await this.d.activeAccount())?.id !== active.id) return;
      this.d.status(`Waiting for your approval to switch to ${candidate.email}.`);
      const answer = await this.d.ask(active, candidate, config.modelId);
      if (!stillEnabled()) return;
      if (answer === 'stop') { await this.d.stop(); return; }
      if (answer !== 'switch') {
        this.cooldowns.set(key, this.now() + 10 * 60000);
        this.d.status('Reminder paused for 10 min. Monitoring remains enabled.'); return;
      }
      if (!this.d.accounts().some(a => a.id === candidate.id)) return;
      // The notification may have been open for minutes. Revalidate both sides
      // and the active session before honoring this specific approval.
      if (this.d.isBusy() || (await this.d.activeAccount())?.id !== active.id) return;
      await this.d.check(active);
      await this.d.check(candidate);
      if (!stillEnabled() || this.d.isBusy() || (await this.d.activeAccount())?.id !== active.id) return;
      if (!exhausted(active, config.modelId) || !available(candidate, config.modelId)) {
        this.d.status('Quota changed while waiting. Rechecking on the next cycle.'); return;
      }
      await this.d.switchAccount(candidate);
      this.backoffMap.clear();
      this.d.status('Switched. Watching the new active account · checks every 20s');
    } catch {
      this.d.status('Monitor could not complete this check. Retrying in 20 seconds.');
    } finally { this.releaseLease(); this.running = false; }
  }

  /**
   * Releases any active port lease.
   */
  releaseLease() { const release = this.release; this.release = null; release?.(); }
}

module.exports = { QuotaMonitor, nextAccounts, exhausted, available };
