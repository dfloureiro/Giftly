// Prints a one-time link (valid 48 h) to set a new password for an account.
//   docker exec giftly node scripts/reset-password.js <username>
import { runAsDataOwner, linkUrl } from './_common.js';

runAsDataOwner();
const username = process.argv[2];
const { users, links, LINK_HOURS } = await import('../src/accounts.js');

if (!username) {
  console.error('Usage: node scripts/reset-password.js <username>');
  console.error(`Accounts: ${users.all().map((u) => u.username).join(', ') || '(none)'}`);
  process.exit(2);
}
const user = users.byUsername(username);
if (!user) {
  console.error(`No account "${username}". Accounts: ${users.all().map((u) => u.username).join(', ') || '(none)'}`);
  process.exit(1);
}
const token = links.create({ userId: user.id });
console.log(`Open this link within ${LINK_HOURS} hours to set a new password for "${user.username}":`);
console.log(linkUrl(`/reset/${token}`));
