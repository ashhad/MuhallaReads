# 📚 Muhalla Reads

A private neighbourhood library. Neighbours list the books they own, find the ones they need, and
borrow them from each other. **Nobody's phone number is shown to anyone** unless they choose
to share it with one person.

## How it works

The **website** (installable on the home screen, nothing to download) is where everything
happens. **WhatsApp** is used only to join, manage your account, and get notifications.

1. **Join by invite, approved by an admin:** open a member's personal invite link (or use the join
   code) and message the library's number, agree to the [Terms](public/terms.html) (members lend and
   borrow at their own risk), then answer two quick questions: your **building or
   society** and your **locality** (at least one). Neighbours see only your name plus those, e.g.
   "Ayesha · Green Park Tower, Saket", never a flat number or address. An admin is told who you are
   and who invited you, and approves you on WhatsApp or in the app; until then you can browse titles
   only. Members get new-book alerts (free WhatsApp messages only; `alerts off` to stop).
2. **Add books in the app:** scan barcodes one after another, type a title, or take a shelf photo
   (optional, needs an Anthropic key).
3. **Find and request:** search, tap **Request**, add a note if you like.
4. **Get notified on WhatsApp:** the owner gets "Bilal (Sunrise Apartments, Saket) would like to
   borrow Dune", with Bilal's borrowing record ("Returned 4 of 4 on time · invited by Ayesha") and an
   **Open request** button. They accept or decline in the app; accepting asks them to confirm they
   lend at their own risk. Nobody can hold more than 2 borrowed books at once (`MAX_BORROWED`).
5. **Arrange the hand-over** in the app's private chat. Each new message is notified on WhatsApp
   with a **Reply** button. Either person can tap **Share my number** to share it with that one
   person.
6. **Return:** the borrower gets a reminder before the due date, and the owner taps
   **Got it back**. A late book means weekly reminders to the borrower, a note to the owner, and
   after two weeks a note to the admins and to whoever invited the borrower. Nobody can delete their
   account while holding someone's book.
7. **Library rules:** the borrower can ask for **one more week** (the owner agrees; at most
   `MAX_RENEWALS`, default 2, and not when someone's waiting). A lent-out book has a **queue**: when
   it's back, the first in line is told and it's kept for them for 2 days, then the next. While a
   book is **overdue**, its borrower can't borrow or queue for others. **30 days after the due
   date** the owner can mark it **lost**: it leaves the catalogue, and the borrower replaces it or
   agrees a price before borrowing again (the owner taps *Settled*, or *Got it back* if it turns up).

Also in the app: **Tell me when someone adds it** (wishlist), block, and account deletion.

### Trust

- **Badges** next to names, earned by being a good neighbour (only positive things are shown):
  📰 *Fresh off the press* (joined in the last 30 days), 📗 *Never overdue* (3+ books returned, all
  on time), 📚 *Bestseller* (lent 5+ books) and 🏛️ *Classic* (Never overdue and a Bestseller, member
  for 3+ months). Tap a name to see a member's card: badges, member since, who invited them, and how
  many books they've listed, lent and returned.
- **Lend only to Never overdue readers:** a per-book option on the Me tab, for books you treasure.
- Who gets in is still decided by admins, who see each newcomer's name, building and inviter.
- **Hand-over:** the loan period starts when either person taps *Got the book* / *Handed over* (or
  3 days after acceptance if nobody does). A loan can be called off until then, and doesn't count
  in anyone's record.

On WhatsApp: `login` (a one-time sign-in button, no password), `name …`, `building …`,
`locality …`, `delete me`, `help`, and for admins `stats`, `members`, `remove member <id>`.
Anything else sent to the bot gets a button that opens the app.

### Privacy

- Phone numbers are stored only on your server, so the bot can message people. The website and
  the bot never show them, except a number its owner explicitly shared with one person.
- Messages between neighbours are tied to a specific book request. People can't message each
  other out of the blue, and either side can block the other.
- Anyone can delete their account and data at any time (`delete me`, or the Me tab).
- The bot never posts in groups and never sends promotions. See `public/privacy.html`.

### Cost

Hosting can be free (see [Oracle Cloud guide](docs/deploy-oracle.md)). WhatsApp is pay-per-message,
and the app is built to stay within the free allowance most of the time:

- Replies to someone who messaged the bot in the last 24 hours are free (first 1,000 a month).
- Telling someone about a request while they're away uses one pre-approved **utility template**
  (about ₹0.14 in India). They get at most one while away; the rest wait until they're back.
- A monthly cap (`MONTHLY_TEMPLATE_LIMIT`, default 200 ≈ ₹27) stops paid messages entirely.

A 50-household pilot should cost roughly ₹5–15 a month. Admins can send `stats` to the bot to
see this month's usage. Photo scanning (optional) is billed separately by Anthropic and capped by
`PHOTO_MONTHLY_BUDGET_INR` (default ₹90 a month).

## Run it

Needs **Node.js 22.13 or newer**. Data is kept in a single SQLite file under `data/`.

```bash
npm install
cp .env.example .env    # then fill it in
npm start               # http://localhost:3000
npm test
```

To try the website without WhatsApp, create a sign-in link from the command line:

```bash
npm run login-link -- 9800000001 "Ayesha (Block C)"
```

## Deploy

**Security:** see [docs/security.md](docs/security.md) for what's protected and a checklist.

**Free option:** [Oracle Cloud Always Free VM](docs/deploy-oracle.md). A step-by-step guide and a
one-command setup script (`deploy/oracle/setup.sh`) cover HTTPS, auto-restart and daily backups;
`deploy/oracle/soc-setup.sh` adds a free security monitor (CrowdSec, alerts, a daily report).

Any other host that runs Node or Docker and keeps a persistent disk also works:

```bash
docker build -t muhallareads .
docker run -p 3000:3000 -v muhalla-data:/data --env-file .env muhallareads
```

The camera (barcode scanning) only works over **https**.

## WhatsApp setup (Meta Cloud API)

You need a phone number that isn't already on WhatsApp, e.g. a spare family SIM. It only has to
receive one verification SMS or call.

1. At <https://developers.facebook.com> create an app (type *Business*) → add **WhatsApp**.
2. In *WhatsApp → API Setup*, add your phone number and verify it. Set a two-step verification
   PIN and keep it safe. Copy the **Phone number ID**.
3. Create a **permanent access token**: Business settings → System users → add a user → generate
   a token with `whatsapp_business_messaging` and `whatsapp_business_management`. Copy the
   **App secret** from *App settings → Basic*.
4. Fill in `.env`: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`,
   `WHATSAPP_VERIFY_TOKEN` (any random string), `WHATSAPP_DISPLAY_NUMBER` (the bot's number),
   `PUBLIC_URL` and `ADMIN_PHONES` (your own number).
5. In *WhatsApp → Configuration*, set the webhook URL to `https://YOUR-DOMAIN/webhooks/whatsapp`
   with the same verify token, and subscribe to the **messages** field.
6. Submit the four message templates in [docs/whatsapp-templates.md](docs/whatsapp-templates.md).
   Once they're approved, set `WHATSAPP_TEMPLATES=on`.
7. Add a payment method in WhatsApp Manager (needed once paid templates start), and share the
   bot's number and community code in your community group.

## Settings

See `.env.example` for all of them. The main ones:

| Variable | What it does |
|---|---|
| `COMMUNITY_NAME` | The library's name, shown in the app and the bot |
| `JOIN_CODE` | Code new people send (`join <code>`) to get in. Empty = open. Changing it doesn't affect existing members |
| `ADMIN_PHONES` | Numbers allowed to use `stats`, `members`, `remove member <id>` |
| `LOAN_DAYS` | Loan length before reminders (default 21) |
| `MAX_BORROWED` | Most books one member can have borrowed at the same time (default 2) |
| `MAX_RENEWALS` | How many times a loan can get one more week, with the owner's OK (default 2) |
| `MONTHLY_TEMPLATE_LIMIT` | Cap on paid WhatsApp messages per month (default 200) |
| `WHATSAPP_TEMPLATES` | `off` until Meta approves the templates |
| `ANTHROPIC_API_KEY` | Turns on shelf-photo recognition |
| `CLAUDE_MODEL` | Model that reads photos (default `claude-haiku-5-5`) |
| `PHOTO_DAILY_LIMIT` | Photos each member can scan in 24 hours (default 10) |
| `PHOTO_MONTHLY_LIMIT` | Photos everyone together can scan per month (default 300) |
| `PHOTO_MONTHLY_BUDGET_INR` | Monthly spend cap for photo scanning, in rupees (default 90) |
| `USD_INR_RATE` | Rupees per US dollar for showing costs (default 88; ~105 includes GST and card fees) |

Photos are read by Claude, one API call each. Haiku (the default) costs about $0.001 (₹0.10) per
shelf photo; Sonnet and Opus read crowded shelves better but cost roughly 20× and 40× more. The app
works out each photo's real cost from the token counts Claude returns and pauses scanning for
everyone once the month reaches `PHOTO_MONTHLY_BUDGET_INR` or `PHOTO_MONTHLY_LIMIT`. Admins get a
WhatsApp message at 50%, 80% and 100%, a summary on Monday mornings in weeks with scans, and see
the running total on their Me tab and in `stats`. Sonnet and Opus requests also opt in to
Anthropic's server-side fallback (`fallbacks: "default"`), so a declined photo is retried by
another model.

## Code map

```
public/           website: plain HTML/CSS/JS, no build step
src/server.js     Express app and JSON API
src/bot.js        WhatsApp: joining, account settings, sign-in links
src/library.js    requests, loans, private chat, wishlist, reminders
src/notifier.js   WhatsApp notifications: free reply / one template / wait
src/whatsapp.js   Meta Cloud API: sending, webhook
src/db.js         SQLite storage (node:sqlite)
src/lookup.js     book details from Open Library, with Google Books as fallback
src/vision.js     finding books in photos with Claude (and what each call cost)
src/photos.js     hard limits and cost alerts for photo scanning
src/security.js   security headers, rate limits, trusted cover hosts
scripts/          admin helpers
deploy/oracle/    free-hosting setup script, backups, two-factor SSH, security monitor
```
