// First start: create the initial account from ADMIN_USERNAME + ADMIN_PASSWORD.
// After that those variables are ignored (with a warning), and accounts are managed in the admin.
import { config } from './config.js';
import { users, hashPassword, validateAccount } from './accounts.js';
import { takeLegacyNotifySettings, seedUserNotifySettings } from './notify.js';

const NOTIFY_ENV = ['NOTIFY_NTFY_URL', 'NOTIFY_NTFY_TOKEN', 'NOTIFY_TELEGRAM_BOT_TOKEN', 'NOTIFY_TELEGRAM_CHAT_ID', 'NOTIFY_WEBHOOK_URL', 'NOTIFY_EVENTS'];

export async function bootstrapAccounts() {
  if (users.count() > 0) {
    if (process.env.ADMIN_PASSWORD) {
      console.warn('ADMIN_PASSWORD is ignored: accounts already exist. You can remove ADMIN_PASSWORD and ADMIN_USERNAME.');
    }
    const stale = NOTIFY_ENV.filter((k) => process.env[k]);
    if (stale.length) console.warn(`${stale.join(', ')} ignored: notifications are set per user in the admin (Profile).`);
    return;
  }

  const username = config.bootstrapUsername;
  const password = config.bootstrapPassword;
  if (!password) {
    console.warn('No accounts yet. Set ADMIN_USERNAME and ADMIN_PASSWORD to create the first one, then restart.');
    return;
  }
  const error = validateAccount({ username, name: username, password });
  if (error) {
    console.error(`Cannot create the first account from ADMIN_USERNAME/ADMIN_PASSWORD (${error}). ` +
      'Usernames: 2–32 lowercase letters, digits, ".", "_" or "-". Passwords: at least 8 characters.');
    return;
  }
  const id = users.create({ username, name: username, passwordHash: await hashPassword(password) });
  // Upgrades from 1.x: the old global notification settings become this account's.
  seedUserNotifySettings(id, takeLegacyNotifySettings());
  console.log(`Created the first account "${username}". Log in at /admin; ADMIN_PASSWORD is no longer needed after this.`);
}
