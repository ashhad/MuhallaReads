# 📚 Muhalla Reads

A private neighbourhood library that lives in WhatsApp. Neighbours list the books they own, find
the ones they need, and borrow them from each other. **Nobody's phone number is ever shown to
anyone** unless they choose to share it with one person.

## How it works

Everything happens in a chat with the library's WhatsApp number, plus an optional website for
browsing and scanning books. Nothing to install.

1. **Join:** message the library's number with the join code (if one is set), then answer two
   quick questions: your **building or society** and your **locality** (at least one). Neighbours
   see only your name plus those, e.g. "Ayesha · Green Park Tower, Saket", never a flat number
   or address.
2. **Add books:** type `add Dune by Frank Herbert`, send an ISBN, or send a **photo of your
   shelf**. On the website you can also scan barcodes one after another.
3. **Find:** type any title or author. Results show which neighbours have it.
4. **Request:** tap **Ask Ayesha** (or send `want 12`). Ayesha gets a WhatsApp message with
   **Accept / Decline** buttons. Neither number is revealed.
5. **Arrange the hand-over** in a private chat relayed by the bot (`msg 7 …`, or simply
   swipe-reply). Either person can tap **Share my number** to share it with that one person.
6. **Return:** the borrower gets a reminder before the due date, and the owner sends
   `returned 7` (or taps *Got it back* on the website).

Also available: **notify me** (be told when a book you searched for gets added), `block`,
`requests`, `my books`, `undo`, `name …`, `building …`, `locality …`, `delete me` (removes your account and all your data),
and `login` (sends a one-time link that signs you into the website, with no password and no phone
number entry).

### Privacy

- Phone numbers are stored only on your server, so the bot can message people. The website and
  the bot never show them, except a number its owner explicitly shared with one person.
- Messages between neighbours go through the bot, tied to a specific book request. People can't
  message each other out of the blue, and either side can block the other.
- Anyone can delete their account and data at any time (`delete me`).
- The bot never posts in groups and never sends promotions.

### Cost

Hosting can be free (see [Oracle Cloud guide](docs/deploy-oracle.md)). WhatsApp is pay-per-message,
and the app is built to stay within the free allowance most of the time:

- Replies to someone who messaged the bot in the last 24 hours are free (first 1,000 a month).
- Telling someone about a request while they're away uses one pre-approved **utility template**
  (about ₹0.14 in India). They get at most one while away; the rest wait until they're back.
- A monthly cap (`MONTHLY_TEMPLATE_LIMIT`, default 200 ≈ ₹27) stops paid messages entirely.

A 50-household pilot should cost roughly ₹5–15 a month. Admins can send `stats` to the bot to
see this month's usage. Photo scanning (optional) is billed separately by Anthropic.

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

**Free option:** [Oracle Cloud Always Free VM](docs/deploy-oracle.md). A step-by-step guide and a
one-command setup script (`deploy/oracle/setup.sh`) cover HTTPS, auto-restart and daily backups.

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
| `MONTHLY_TEMPLATE_LIMIT` | Cap on paid WhatsApp messages per month (default 200) |
| `WHATSAPP_TEMPLATES` | `off` until Meta approves the templates |
| `ANTHROPIC_API_KEY` | Turns on shelf-photo recognition |

Photos are read by Claude (`claude-opus-5-5` by default; change it with `CLAUDE_MODEL`). Each
photo is one API call. Requests opt in to Anthropic's server-side fallback (`fallbacks: "default"`),
so if the main model declines a photo, another model retries it.

## Code map

```
public/           website: plain HTML/CSS/JS, no build step
src/server.js     Express app and JSON API
src/bot.js        WhatsApp commands
src/library.js    requests, loans, private chat, wishlist, reminders
src/notifier.js   cheapest way to reach someone (free reply / one template / wait)
src/whatsapp.js   Meta Cloud API: sending, webhook
src/db.js         SQLite storage (node:sqlite)
src/lookup.js     book details from Open Library, with Google Books as fallback
src/vision.js     finding books in photos with Claude
scripts/          admin helpers
deploy/oracle/    free-hosting setup script
```
