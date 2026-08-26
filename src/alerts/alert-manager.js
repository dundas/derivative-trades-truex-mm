/**
 * Normalize watchdog/alert reason strings for deduplication keys so variable
 * fragments (e.g. ` for 5135s`) do not defeat the cooldown.
 */
export function normalizeAlertReason(reason) {
  let s = String(reason ?? '');
  s = s.replace(/ for \d+s/gi, '');
  s = s.replace(/ \(\d+ orders?\)/gi, '');
  s = s.replace(/\$[\d,]+\.?\d*/g, '');
  s = s.replace(/\b\d+\.\d+\s*BTC\b/gi, '');
  return s.trim();
}

export class AlertManager {
  constructor(options = {}) {
    this.slackWebhookUrl = options.slackWebhookUrl || null;
    this.alertEmail = options.alertEmail || null;
    this.cooldownMs = options.cooldownMs || 600000; // 10 minutes
    this.logger = options.logger || console;
    this._lastAlertTime = {}; // keyed by reason
  }

  async sendAlert({ reason, level = 'error', details = {} }) {
    const key = normalizeAlertReason(reason);
    const now = Date.now();

    // Deduplication cooldown
    if (this._lastAlertTime[key] && (now - this._lastAlertTime[key]) < this.cooldownMs) {
      this.logger.debug(`[AlertManager] Alert suppressed (cooldown): ${reason}`);
      return { suppressed: true };
    }

    this._lastAlertTime[key] = now;

    const message = this._buildAlertMessage({ reason, level, details, now });
    const results = await Promise.allSettled([
      this._sendSlack(message, { reason, level, details }),
      this._sendEmail(`[TrueX MM] ALERT: ${reason}`, message),
    ]);

    return { sent: true, results };
  }

  async sendRecovery({ reason, details = {} }) {
    // Clear cooldown so next alert fires immediately (same key shape as sendAlert)
    delete this._lastAlertTime[normalizeAlertReason(reason)];

    const message = this._buildRecoveryMessage({ reason, details });
    await Promise.allSettled([
      this._sendSlack(message, { reason, level: 'recovery', details }),
      this._sendEmail(`[TrueX MM] RECOVERY: ${reason}`, message),
    ]);
  }

  _buildAlertMessage({ reason, level, details, now }) {
    const ts = new Date(now).toUTCString();
    const pos = details.position ? `pos=${JSON.stringify(details.position)}` : '';
    const bal = details.balances ? `bal=${JSON.stringify(details.balances)}` : '';
    return `🚨 *TrueX Market Maker ALERT* [${level.toUpperCase()}]\n\n*Reason:* ${reason}\n${pos}\n${bal}\n*Time:* ${ts}`;
  }

  _buildRecoveryMessage({ reason, details }) {
    return `✅ *TrueX Market Maker RECOVERY*\n\n*Recovered from:* ${reason}\n*Time:* ${new Date().toUTCString()}`;
  }

  async _sendSlack(text, { reason, level, details } = {}) {
    if (!this.slackWebhookUrl) return;
    try {
      const payload = {
        text,
        username: 'TrueX MM Monitor',
        icon_emoji: level === 'recovery' ? ':white_check_mark:' : ':rotating_light:',
      };
      const resp = await fetch(this.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) this.logger.warn(`[AlertManager] Slack webhook failed: ${resp.status}`);
    } catch (err) {
      this.logger.warn(`[AlertManager] Slack send error: ${err.message}`);
    }
  }

  async _sendEmail(subject, body) {
    if (!this.alertEmail) return;

    const apiKey = process.env.CIRCLEINBOX_API_KEY;
    const fromEmail = process.env.ALERT_FROM_EMAIL || 'alerts@derivative.email';

    if (!apiKey) {
      this.logger.warn('[AlertManager] CIRCLEINBOX_API_KEY not set — email skipped');
      return;
    }

    try {
      const resp = await fetch('https://api.circleinbox.com/api/v1/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: { email: fromEmail, name: 'True Markets Alerts' },
          to: this.alertEmail,
          subject,
          text: body,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) this.logger.warn(`[AlertManager] CircleInbox email failed: ${resp.status}`);
    } catch (err) {
      this.logger.warn(`[AlertManager] Email send error: ${err.message}`);
    }
  }
}
