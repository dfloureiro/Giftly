# Using Giftly

← [Back to the README](../README.md)

- [Finding your way around](#finding-your-way-around)
- [Gift lists and guests](#gift-lists-and-guests)
- [Wishlists](#wishlists)
- [Keeping the surprise](#keeping-the-surprise)
- [Gifts to give](#gifts-to-give)
- [Shared or private](#shared-or-private)

## Finding your way around

Log in at `/login`. You land on **Occasions**. The main menu (a bar at the bottom on a phone) goes from the gifts you give to the ones you receive:

**Occasions** · **People** · **Lists** · **My wishlist**

- **Occasions:** what's coming up. *Upcoming* shows the next 60 days as cards ("Christmas: 6 of 18 missing", "Ana's birthday: no gift yet"); from 1 November that Christmas is pinned on top. *All* lists every occasion and birthday by year.
- **People:** everyone you give gifts to, with search. A person's page has everything about them: their wishlist, upcoming occasions, and what they got in past years.
- **Lists:** the gift lists you share with guests.
- **My wishlist:** what you'd like to receive.

A few things work the same everywhere:

- The main action of a screen is at the top: *+ New occasion*, *+ New person*, *+ New list*, *+ Add to the wishlist*, *+ Add a gift*.
- A page's settings and rarer actions are in its **⚙️ menu**: a list (settings, new link, delete), an occasion (edit, duplicate for next year, delete), a person (edit, delete), your wishlist (who can see it).
- Every detail page has a *←* link back to where you came from.
- Your **Profile**, **Notifications**, the **Admins** and *Log out* are in the account menu (your initials, top right), next to the PT · EN switch.

## Gift lists and guests

A list is what you share for an occasion: a wedding, a birthday, Christmas.

### Adding gifts

Add a link to any shop, or a plain item without a link. For links, Giftly shows the shop's **image and price** on its own:

- **Images:** the server fetches the page in the background and **keeps a copy of the image** with your data, so guests never load anything from the shops. Some shops block automated requests; then **upload a photo** (resized in your browser) or paste an image link. An image is only ever replaced by another image.
- **Prices** only come from the shop link: there's no price field. Available gifts are re-checked once a day, and the last known price stays if a check fails. Gifts without a link, or from shops that block Giftly, show no price.
- **Order:** drag gifts by their handle (⋮⋮) with the mouse or a finger. The ↑/↓ buttons still work without JavaScript.

### Sharing

Every list has a **secret link** (`/l/<22 random characters>`). Anyone with the link can open the list; it never asks for a login and never changes on its own.

- *Generate new link* (in the list's ⚙️ menu) replaces it. The old link stops working and everyone who joined is logged out.
- **Archive** a list to close it without deleting anything.

### What guests see

1. They open the link and type their name. That's all: no account, no email, nothing tracked.
2. They see the available gifts and tap *I'll give this one*.
3. The gift **disappears for everyone else**, so nobody buys the same thing twice. If two people tap at the same moment, only one gets it.
4. Their picks stay at the top, and they can give them up.

A guest is recognised by their name within a list (not case-sensitive), so typing the same name on another device shows the same picks. That's deliberately simple: it's built for family and friends, not strangers.

### What you see

The admin shows everything: who picked what and when, and who joined. You can:

- **Release** any gift.
- **Reserve** a gift for someone who told you in person: type their name, or pick a guest who already joined. The reservation belongs to that guest: when they open the list with that name, they see it in their picks ("Reserved for you by …") and can give it up. The other admins are notified.

## Wishlists

### My wishlist

What you'd like to receive, in order of preference, with link, notes, and the shop's image and price.

- When you remove an item, Giftly asks why: *I bought it*, *I don't want it any more* or *I received it*.
- Removed and received items stay in a history, where you can put them back or delete them for good. Lists that had them keep their copy.
- The other admins see your wishlist on your page in **People**, unless you make it private (in its ⚙️ menu).

### Ideas for other people

For people who aren't admins (children, grandparents…), the admins keep a **wishlist of ideas** on their page. Everyone who can see the person can add, edit and reorder ideas.

- Tick *Only for me* to keep an idea **private**: only you see it.
- An admin's page can also have ideas for them, next to their own wishlist. They never see those.

### What you can do with a wishlist

- **Create a guest list from it.** Choose the items. They stay **linked**: when an item changes, the list follows, and new wishlist items join the list on their own (or wait for your approval, per list). A list can mix an admin's own wishlist with the ideas for them. You can still add the list's own gifts, add notes, or hide a linked item in just that list. A list with private ideas is always private.
- **Take an item with "I'll give it".** It's reserved in every list and becomes a *planned* gift for that person, in the occasion you choose. From an occasion's checklist, *Pick from their wishlist* does the same.

### Editing a linked item from a list

Whoever can edit the list can edit its items:

- **An idea** is changed in the wishlist itself, so every list with it follows. The form says so.
- **An item from another admin's own wishlist** is changed **in that list only**. Their wishlist never changes and they never see it. The list shows *Edited in this list*.
  - Whatever you didn't change keeps following the wishlist.
  - If they later change a field you changed, your version stays, and the list shows *The wishlist changed* with a button to take theirs.
  - *Use the wishlist's details again* undoes all your changes.
- A new link fetches its own image and price again (a photo you uploaded stays).
- Editing never touches reservations.

## Keeping the surprise

**An admin never sees what was reserved, planned or bought for them.**

- Your own wishlist page looks exactly the same whether something was reserved or not, and removing a reserved item gives exactly the same answer as removing any other.
- A list made from someone's wishlist (or from the ideas for them) is **never visible to them**, even when shared with the other admins, and its notifications never reach them. So you can't create a list from your own wishlist.
- A wishlist item can only be reserved **once across every list** (and "I'll give it"), even if two people try at the same moment.
- If the owner removes an item someone already reserved, that guest keeps it in their picks with a note ("they already bought it — don't buy it"), and the list's organiser (or the admin giving it) is notified.
- When a list is archived, or a gift from the wishlist is marked *given*, the item leaves the owner's active wishlist (as received).

This is enforced by the app and tested. Whoever has access to the server itself can still read the database.

## Gifts to give

*Occasions* and *People* are for planning the gifts **you** give. They aren't tied to the guest lists.

### People

Name, birthday (day and month; the year is optional, for ages), notes, and whether you give them a Christmas gift.

- **Favourites:** star the people you give to most. Favourites are per admin and come first.
- **Search** people (name or notes) and occasions as you type.
- **History:** what you gave each person, by year and occasion.

**Every admin has a record** in People, created when they join, so the others can plan gifts for them. That record and everything on it (gifts, ideas, its birthday, occasions only about them, totals and reminders) is **never visible to that admin**, even when shared.

- An admin's birthday comes from their **Profile**, so nobody has to type it.
- If someone with the same name is already in People when an admin joins, Giftly asks the other admins *"Is it the same one?"* (*Link* / *Create a new one*). It never links them on its own.
- An admin's record can't be unlinked or deleted while the account exists.

### Occasions

- **Birthdays** appear every year on their own, from each person's date.
- **Christmas:** *Create Christmas YYYY* creates that year's Christmas with everyone marked for Christmas. You can add or remove people just for that year. Marking someone for Christmas later also adds them to this year's Christmas, if it already exists.
- **Other occasions** (christenings, weddings…) have a name, a date and participants.
- **Duplicate** an occasion for next year, with the same people (gifts aren't copied).

### The checklist

Each occasion has a checklist made for the phone:

- "12 of 18 people already have a gift", and the total spent;
- each person's gifts, from *planned* to *bought* to *given*;
- what they got the year before;
- a filter for people still without a gift.

Ideas live in the wishlists; the checklist only holds what you're actually going to give.

### Gifts

- A gift can have a link, notes, an image (from the link or uploaded) and a price.
- The price comes from the shop's page when it shows one, and is kept up to date until the gift is bought. Then it freezes, so totals show what you paid. When the shop shows no price, you type it (in `CURRENCY`, default `EUR`).
- **Joint gifts:** one gift can be for several people, like a Christmas gift for a couple. It counts as a gift for each of them, shows in each one's history, and enters the total once. Birthday gifts stay individual.

### Reminders

Giftly can remind you when a birthday or occasion is coming up and no gift has been bought yet. See [Notifications and reminders](notifications.md#reminders).

## Shared or private

Lists, people, occasions and gifts are each either **shared** (all admins see them) or **private** (only whoever created them).

- Only the creator can change who sees an entry.
- A joint gift is only shown to someone who can see every person it's for.
- Removing an admin deletes their private entries and keeps the shared ones.
