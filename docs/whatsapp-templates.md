# WhatsApp message templates

WhatsApp only lets the bot message someone **first** using a template that Meta has approved.
Examples are telling an owner that a neighbour wants their book, or sending a return reminder.
Replies to people who messaged the bot in the last 24 hours don't need templates.

MuhallaReads uses four templates. Create them in **WhatsApp Manager → Message templates → Create
template**, exactly as below, then set `WHATSAPP_TEMPLATES=on` once all four are approved. Until
then, keep it `off`: notifications wait until the person next messages the bot or opens the website.

For each template:

- **Category:** Utility. Each one is about a request the person made or a book they lent, so it
  isn't marketing. Utility costs about ₹0.115 + GST per message in India; marketing costs about
  7× more.
- **Language:** English (code `en`). If you pick "English (US)" instead, set
  `WHATSAPP_TEMPLATE_LANG=en_US`.
- **Name:** exactly as shown. The app looks templates up by name.
- **Sample values:** Meta asks for an example of each `{{n}}`. Use the ones given.

---

### 1. `book_request`

Sent to a book's owner when someone asks to borrow it.

**Body**

```
Hi, {{1}} has asked to borrow your book "{{2}}". Their note: {{3}}. Please accept or decline below.
```

Samples: `{{1}}` = `Bilal (Block D)`, `{{2}}` = `Dune`, `{{3}}` = `Could I pick it up on Sunday?`

**Buttons:** Quick reply → `Accept`, Quick reply → `Decline`

---

### 2. `request_update`

Sent when there's news about a request: accepted, declined, a new chat message, or a shared
number.

**Body**

```
Update about the book "{{1}}": {{2}}. Reply to this chat to see the details.
```

Samples: `{{1}}` = `Dune`, `{{2}}` = `Ayesha (Block C) agreed to lend it`

**Buttons:** none

---

### 3. `return_reminder`

Sent to a borrower two days before a book is due, and once more if it's three days overdue.

**Body**

```
Reminder: "{{1}}", borrowed from {{2}}, is due back on {{3}}. Thank you.
```

Samples: `{{1}}` = `Dune`, `{{2}}` = `Ayesha (Block C)`, `{{3}}` = `8 Nov`

**Buttons:** none

---

### 4. `wishlist_match`

Sent when a book someone asked to be notified about gets added.

**Body**

```
Good news: "{{1}}", which you asked about, is now available from {{2}}. Tap below to request it.
```

Samples: `{{1}}` = `Gitanjali`, `{{2}}` = `Ayesha (Block C)`

**Buttons:** Quick reply → `Request it`

---

## How the app keeps costs down

- If the person messaged the bot in the last 24 hours, the app sends a normal message instead.
  The first 1,000 of these each month are free.
- While someone is away, they get **at most one** template. Anything else waits and is delivered
  together (free) when they next message the bot, or shown on the website.
- After `MONTHLY_TEMPLATE_LIMIT` templates in a month (default 200, about ₹27), templates stop
  and notifications simply wait. Admins can check usage by sending `stats` to the bot.
- No promotional or broadcast messages are ever sent.

If Meta rejects a template or files it under Marketing, adjust the wording to be plainer and
resubmit. Keep the `{{n}}` placeholders in the same order, and don't put one at the very start or
end of the text.
