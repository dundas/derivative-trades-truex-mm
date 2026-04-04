export class AlertManager {
  constructor(options = {}) {
    this.slackWebhookUrl = options.slackWebhookUrl || null;
    this.alertEmail = options.alertEmail || null;
    this.alertPhone = options.alertPhone || null;
    this.telnyxApiKey = options.telnyxApiKey || null;
    this.telnyxFromNumber = options.telnyxFromNumber || null;
    this.cooldownMs = options.cooldownMs || 600000; // 10 minutes
    this.logger = options.logger || console;
    this._lastAlertTime = {}; // keyed by reason
  }

  async sendAlert({ reason, level = 'error', details = {} }) {
    const key = reason;
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
      this._sendSms(`[TrueX MM] ALERT: ${reason} | ${new Date(now).toISOString()}`),
    ]);

    return { sent: true, results };
  }

  async sendRecovery({ reason, details = {} }) {
    // Clear cooldown so next alert fires immediately
    delete this._lastAlertTime[reason];

    const message = this._buildRecoveryMessage({ reason, details });
    await Promise.allSettled([
      this._sendSlack(message, { reason, level: 'recovery', details }),
      this._sendEmail(`[TrueX MM] RECOVERY: ${reason}`, message),
      this._sendSms(`[TrueX MM] RECOVERY: ${reason} | ${new Date().toISOString()}`),
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
    // Dynamic import to avoid crashing when nodemailer not installed
    let nodemailer;
    try {
      nodemailer = (await import('nodemailer')).default;
    } catch {
      this.logger.warn('[AlertManager] nodemailer not installed — email skipped');
      return;
    }

    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_USER_PASS;
    if (!gmailUser || !gmailPass) {
      this.logger.warn('[AlertManager] GMAIL_USER/GMAIL_USER_PASS not set — email skipped');
      return;
    }

    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: gmailUser, pass: gmailPass },
      });
      await transporter.sendMail({
        from: gmailUser,
        to: this.alertEmail,
        subject,
        text: body,
      });
    } catch (err) {
      this.logger.warn(`[AlertManager] Email send error: ${err.message}`);
    }
  }

  async _sendSms(message) {
    if (!this.telnyxApiKey || !this.telnyxFromNumber || !this.alertPhone) return;
    // Truncate to 160 chars for SMS
    const text = message.length > 160 ? message.slice(0, 157) + '...' : message;
    try {
      const resp = await fetch('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.telnyxApiKey}`,
        },
        body: JSON.stringify({
          from: this.telnyxFromNumber,
          to: this.alertPhone,
          text,
        }),
      });
      if (!resp.ok) this.logger.warn(`[AlertManager] Telnyx SMS failed: ${resp.status}`);
    } catch (err) {
      this.logger.warn(`[AlertManager] SMS send error: ${err.message}`);
    }
  }
}
