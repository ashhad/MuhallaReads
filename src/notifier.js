// Decides how to reach a member on WhatsApp as cheaply as possible:
//  - If they messaged the bot in the last 24 hours, send a normal message (free up to 1,000/month).
//  - Otherwise queue the full message and send one short pre-approved "utility" template as a nudge
//    (paid, about ₹0.14). Further notifications wait in the queue without more templates until the
//    member next messages the bot, at which point everything queued is delivered.
//  - Templates stop once the monthly budget is used up; messages still wait in the queue and appear in
//    the web app.

const WINDOW_MS = 23.5 * 3600_000; // Meta's window is 24h; keep a safety margin

export function createNotifier({ store, transport, settings, clock = () => new Date() }) {
  const windowOpen = (member) =>
    Boolean(member.last_inbound_at) && clock() - new Date(member.last_inbound_at) < WINDOW_MS;

  async function sendNow(member, { text, buttons, requestId, relay }) {
    const id = await transport.send(member.phone, { text, buttons });
    store.bumpUsage('service');
    if (relay && id && requestId) store.recordOutbound(id, member.id, requestId);
  }

  /**
   * @param {number} memberId
   * @param {object} n
   * @param {string} n.text full message
   * @param {{id: string, title: string}[]} [n.buttons]
   * @param {number} [n.requestId]
   * @param {boolean} [n.relay] a chat message: remember its id so swipe-replies route back
   * @param {{name: string, params: string[], buttons?: string[]}} [n.template] nudge when the window is closed
   * @param {boolean} [n.optional] only send if it's free right now; otherwise drop it
   * @returns {Promise<'sent'|'template'|'queued'|'dropped'>}
   */
  async function notify(memberId, n) {
    const member = store.memberById(memberId);
    if (!member) return 'dropped';

    if (transport && windowOpen(member)) {
      try {
        await sendNow(member, n);
        return 'sent';
      } catch (err) {
        console.error('WhatsApp send failed, queueing instead:', err.message);
      }
    }
    if (n.optional) return 'dropped';

    const alreadyNudged = store.pendingInbox(member.id).length > 0;
    store.addInbox(member.id, { text: n.text, buttons: n.buttons, requestId: n.requestId, relay: n.relay });
    if (!transport || !n.template || alreadyNudged || !settings.templatesEnabled) return 'queued';
    if (store.usageFor().templates >= settings.monthlyTemplateLimit) {
      console.warn('Monthly WhatsApp template budget reached; notification queued.');
      return 'queued';
    }
    try {
      await transport.sendTemplate(member.phone, n.template);
      store.bumpUsage('template');
      return 'template';
    } catch (err) {
      console.error(`WhatsApp template "${n.template.name}" failed:`, err.message);
      return 'queued';
    }
  }

  /**
   * Delivers queued notifications. Called when the member messages the bot (the window is now open).
   * Items about `skipRequestId` are marked delivered without sending, because the member is
   * already acting on that request (e.g. tapped Accept on the template).
   * @returns {Promise<number>} how many were sent
   */
  async function flush(member, { skipRequestId } = {}) {
    const items = store.pendingInbox(member.id);
    if (!items.length) return 0;
    store.markInboxDelivered(items.map((i) => i.id));
    if (!transport) return 0;
    const toSend = items.filter((i) => !skipRequestId || i.request_id !== skipRequestId).slice(-10);
    for (const item of toSend) {
      try {
        await sendNow(member, {
          text: item.text,
          buttons: item.buttons,
          requestId: item.request_id,
          relay: Boolean(item.relay),
        });
      } catch (err) {
        console.error('WhatsApp send failed while delivering queued messages:', err.message);
      }
    }
    return toSend.length;
  }

  return { notify, flush, windowOpen };
}
