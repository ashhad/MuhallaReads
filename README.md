# 📚 MuhallaReads

A neighbourhood library catalogue. Everyone adds the books they own; anyone looking for a book
searches and sees who has it, with a one-tap WhatsApp button to ask to borrow it.

- **Web app** (works on any phone, installable to the home screen)
  - **Find**: search by title, author or ISBN. Each result shows who has a copy, whether it is
    available or lent out, and an **Ask** button that opens WhatsApp with a ready-made message.
    If nobody has it, an **Ask on WhatsApp** button lets you post the request to your group.
  - **Add**, three ways:
    - **Type**: a title, `Title by Author`, or an ISBN. Suggestions come from Open Library.
    - **Scan barcodes**: point the camera at the barcode on the back. Scan one book or a whole
      stack in a row; each one lands in a "Ready to add" list.
    - **Shelf photo**: photograph a cover, a pile or a whole shelf. The app reads the titles and
      lists them for you to tick and add. Needs an Anthropic API key (see below).
  - **My books**: mark a book as lent out or returned, or remove it.
- **WhatsApp bot** (optional): the same features over chat.

```
hi                                → help
dune                              → who has Dune? (any text is a search)
add The Alchemist by Paulo Coelho → add a book
add 9780062315007                 → add by ISBN
add                               → add several, one per line
Sapiens
Ikigai by Héctor García
[send a photo]                    → adds every book it can read in the photo
my books                          → your list with numbers
lent 12 / back 12 / remove 12     → manage your books
undo                              → remove the books you just added
```

People are identified by their WhatsApp number, so the web app and the bot share the same
account automatically.

## Run it

Needs **Node.js 22.13 or newer**. There's no separate database server: data is kept in a
SQLite file under `data/`.

```bash
npm install
cp .env.example .env    # optional: edit settings
npm start               # http://localhost:3000
npm test
```

The camera (barcode scanning) only works over **https** or on `localhost`, so deploy behind
HTTPS.

### Deploy

Any host that runs Node or Docker and keeps a persistent disk works, for example Railway,
Render, Fly.io, or a small VPS.

```bash
docker build -t muhallareads .
docker run -p 3000:3000 -v muhalla-data:/data --env-file .env muhallareads
```

Back up the `data/` folder (or the `/data` volume): it holds the whole catalogue.

## Settings

All optional; see `.env.example`.

| Variable | What it does |
|---|---|
| `COMMUNITY_NAME` | Name shown in the app and the bot |
| `JOIN_CODE` | Shared code people need to join. Leave empty for an open catalogue |
| `DEFAULT_COUNTRY_CODE` | Added to local 10-digit numbers (default `91`) |
| `ANTHROPIC_API_KEY` | Turns on **Shelf photo** and WhatsApp photo adding |
| `GOOGLE_BOOKS_API_KEY` | Fallback ISBN lookups get their own quota |

### Photo recognition

Photos are read by Claude (`claude-opus-5-5` by default; change it with `CLAUDE_MODEL`).
Get an API key at <https://console.anthropic.com>, then set `ANTHROPIC_API_KEY`. Each photo is
one API call. The browser shrinks photos to 2000px before uploading, and WhatsApp compresses
them too. Requests opt in to Anthropic's server-side fallback (`fallbacks: "default"`), so if the
main model declines a photo, another model retries it automatically.

## WhatsApp setup

WhatsApp doesn't let bots join group chats, so the bot works as a 1:1 chat. Share its number in
your community group ("message this number to search or add books"). The "Ask" buttons open
a normal chat with the book's owner.

Pick **one** of these options.

### Option A: Meta WhatsApp Cloud API (official)

1. At <https://developers.facebook.com> create an app → add the **WhatsApp** product.
2. From *WhatsApp → API Setup*, copy the **Phone number ID** and create a **permanent access token**
   (System User token with `whatsapp_business_messaging`). Copy the **App secret** from
   *App settings → Basic*.
3. Set `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`,
   `WHATSAPP_VERIFY_TOKEN` (any random string) and `WHATSAPP_DISPLAY_NUMBER` (the bot's number).
4. In *WhatsApp → Configuration*, set the webhook URL to `https://YOUR-DOMAIN/webhooks/whatsapp`
   with the same verify token, and subscribe to the **messages** field.

The test number Meta gives you can only message up to 5 numbers you register. Add a real number
to the WhatsApp Business account to open it to everyone.

### Option B: Twilio

1. In the Twilio console, open *Messaging → Try it out → Send a WhatsApp message* (sandbox) or
   register a WhatsApp sender.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` (e.g.
   `whatsapp:+14155238886`) and `PUBLIC_URL` (your https base URL).
3. Set the incoming-message webhook to `https://YOUR-DOMAIN/webhooks/twilio` (HTTP POST).

With the sandbox, each person first sends the sandbox's `join <word>` message to Twilio's number.

## How it works

```
public/        web app: plain HTML/CSS/JS, no build step
src/server.js  Express app and JSON API
src/db.js      SQLite storage (node:sqlite) and catalogue search
src/lookup.js  book details from Open Library, with Google Books as fallback
src/vision.js  finding books in photos with Claude
src/bot.js     WhatsApp bot commands
src/whatsapp.js  webhooks for the Meta Cloud API and Twilio
```

**Privacy:** members' WhatsApp numbers are visible to other members so they can message each
other. That is the point of the app. Set a `JOIN_CODE` so only your community can get in.
Logging in from another device uses the same name, number and code. There are no passwords,
which suits a trusted neighbourhood group but not a public site.
