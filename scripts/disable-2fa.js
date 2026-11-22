// Turns off two-factor authentication for an account (lost phone and recovery codes)
// and logs it out everywhere.
//   docker exec giftly node scripts/disable-2fa.js <username>
import { runAsDataOwner } from './_common.js';

runAsDataOwner();
const username = process.argv[2];
const { users, sessions } = await import('../src/accounts.js');
const user = username && users.byUsername(username);
if (!user) {
  console.error(`Usage: node scripts/disable-2fa.js <username>\nAccounts: ${users.all().map((u) => u.username).join(', ') || '(none)'}`);
  process.exit(username ? 1 : 2);
}
users.disableTotp(user.id);
sessions.deleteForUser(user.id);
console.log(`Two-factor authentication turned off for "${user.username}". They can log in with their password and turn it on again in their profile.`);
