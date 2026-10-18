# WhatsApp message templates

WhatsApp only lets the bot message someone **first** using a template that Meta has approved.
Examples are telling an owner that a neighbour wants their book, or sending a return reminder.
Replies to people who messaged the bot in the last 24 hours don't need templates; the app sends
those as normal messages with an "Open request" button.

The library uses four templates. Each one has a **Visit website** button that opens the right page
of the app. Create them in **WhatsApp Manager → Message templates → Create template**, exactly as
below, then set `WHATSAPP_TEMPLATES=on` once all four are approved. Until then, keep it `off`:
notifications wait until the person next messages the bot, and the app's Requests tab always shows
everything.

For each template:

- **Category:** Utility. Each one is about a request the person made or a book they lent, so it
  isn't marketing. Utility costs about ₹0.115 + GST per message in India; marketing costs about
  7× more.
- **Language:** English (code `en`). If you pick "English (US)" instead, set
  `WHATSAPP_TEMPLATE_LANG=en_US`.
- **Name:** exactly as shown. The app looks templates up by name.
- **Sample values:** Meta asks for an example of each `{{n}}`. Use the ones given.
- **Button:** choose **Visit website**, type **Dynamic**, button text `Open MohallaReads`, and the
  URL shown, with **your own site address**. The `{{1}}` at the end of the URL is filled in by the
  app (a request number, or a book title).

In the examples below, replace `mohallareads.duckdns.org` with your site's address if it differs.

---

### 1. `book_request`

Sent to a book's owner when someone asks to borrow it.

**Body**

```
Hi, {{1}} has asked to borrow your book "{{2}}". Their note: {{3}}. Open the app to accept or decline.
```

Samples: `{{1}}` = `Bilal (Sunrise Apartments, Saket)`, `{{2}}` = `Dune`, `{{3}}` = `Could I pick it up on Sunday?`

**Button:** Visit website · Dynamic · `Open MohallaReads` · `https://mohallareads.duckdns.org/?request={{1}}`
(sample: `12`)

---

### 2. `request_update`

Sent when there's news about a request: accepted, declined, a new chat message, or a shared
number.

**Body**

```
Update about the book "{{1}}": {{2}}. Open the app to see the details.
```

Samples: `{{1}}` = `Dune`, `{{2}}` = `Ayesha agreed to lend it`

**Button:** Visit website · Dynamic · `Open MohallaReads` · `https://mohallareads.duckdns.org/?request={{1}}`
(sample: `12`)

---

### 3. `return_reminder`

Sent to a borrower two days before a book is due, and once more if it's three days overdue.

**Body**

```
Reminder: "{{1}}", borrowed from {{2}}, is due back on {{3}}. Thank you.
```

Samples: `{{1}}` = `Dune`, `{{2}}` = `Ayesha`, `{{3}}` = `8 Nov`

**Button:** Visit website · Dynamic · `Open MohallaReads` · `https://mohallareads.duckdns.org/?request={{1}}`
(sample: `12`)

---

### 4. `wishlist_alert`

(An earlier version of this guide called it `wishlist_match`. If you submitted that one, ignore or
delete it; the app no longer uses it.)

Sent when a book someone asked to be told about gets added. Keep the wording plain: phrases like
"Good news" or "now available" make Meta treat it as Marketing (about 7× the price, and often not
delivered). If Meta still won't accept it as Utility, skip this template: wishlist alerts then
arrive for free the next time the person messages the bot, and always show in the app.

**Body**

```
Hi, this is the alert you set for "{{1}}". A copy has now been listed by {{2}}. Open the app to see it.
```

Samples: `{{1}}` = `Gitanjali`, `{{2}}` = `Ayesha (Green Park Tower, Saket)`

**Button:** Visit website · Dynamic · `Open MohallaReads` · `https://mohallareads.duckdns.org/?q={{1}}`
(sample: `Gitanjali`)

---

## How the app keeps costs down

- If the person messaged the bot in the last 24 hours, the app sends a normal message instead.
  The first 1,000 of these each month are free.
- While someone is away, they get **at most one** template. Anything else waits and is delivered
  together (free) when they next message the bot, and is always visible in the app.
- After `MONTHLY_TEMPLATE_LIMIT` templates in a month (default 200, about ₹27), templates stop
  and notifications simply wait. Admins can check usage by sending `stats` to the bot.
- No promotional or broadcast messages are ever sent.

If Meta rejects a template or files it under Marketing, adjust the wording to be plainer and
resubmit. Keep the `{{n}}` placeholders in the same order, and don't put one at the very start or
end of the text.
