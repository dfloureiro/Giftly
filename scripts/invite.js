// Prints a one-time invite link (valid 48 h) to create a new admin account.
// Useful if nobody can log in any more.
//   docker exec giftly node scripts/invite.js
import { runAsDataOwner, linkUrl } from './_common.js';

runAsDataOwner();
const { links, LINK_HOURS } = await import('../src/accounts.js');
const token = links.create();
console.log(`Open this link within ${LINK_HOURS} hours to create an admin account:`);
console.log(linkUrl(`/invite/${token}`));
