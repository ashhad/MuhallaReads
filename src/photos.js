// Hard limits on photo recognition, the one feature that costs money each time it's used (Claude API).
//  - Each member can scan `photoDailyLimit` photos in any 24 hours, one at a time.
//  - Every scan's real cost (from the token counts Claude reports) is added to this month's total.
//    Scanning pauses for everyone once the month reaches `photoMonthlyBudgetUsd` or `photoMonthlyLimit`
//    photos, and starts again on the 1st.
//  - Admins are told on WhatsApp at 50%, 80% and 100% of the month's limits, and get a weekly summary
//    on Monday mornings in weeks when photos were scanned.

const ALERT_LEVELS = [50, 80, 100];
const DAY_MS = 86400_000;

export class PhotoLimitError extends Error {}

const usd = (n) => `$${n.toFixed(2)}`;

export function createPhotoLimits({ store, notifier, settings, clock = () => new Date() }) {
  const busy = new Set(); // member ids with a photo being read right now

  function usage() {
    const u = store.usageFor(clock().toISOString().slice(0, 7));
    return {
      photos: u.photos || 0,
      costUsd: u.photo_cost || 0,
      budgetUsd: settings.photoMonthlyBudgetUsd,
      photoLimit: settings.photoMonthlyLimit,
      dailyLimit: settings.photoDailyLimit,
    };
  }

  /** How much of this month's limits is used, in percent (whichever of budget and photo count is further). */
  const level = (u) =>
    Math.max(
      u.budgetUsd > 0 ? (u.costUsd / u.budgetUsd) * 100 : 100, // a budget of 0 (or one that isn't a number) means paused
      u.photoLimit > 0 ? (u.photos / u.photoLimit) * 100 : 100,
    );

  /** Why this member can't scan a photo right now, or null if they can. */
  function blockedReason(member) {
    if (level(usage()) >= 100) {
      return 'Photo scanning is paused until next month. You can still scan barcodes or type titles.';
    }
    const today = store.photoScansSince(new Date(clock() - DAY_MS).toISOString(), member.id).photos;
    if (today >= settings.photoDailyLimit) {
      return `You've scanned ${today} photos in the last 24 hours, the most allowed. Try again tomorrow, or scan barcodes instead.`;
    }
    if (busy.has(member.id)) return 'Still reading your last photo. Please wait for it to finish.';
    return null;
  }

  async function alertAdmins(text) {
    console.warn(text.replace(/\*/g, ''));
    for (const phone of settings.adminPhones || []) {
      const admin = store.memberByPhone(phone);
      if (admin) await notifier.notify(admin.id, { text });
    }
  }

  /**
   * Runs `read()` (one Claude call) if the limits allow it, and records what it cost.
   * @param {object} member
   * @param {() => Promise<{books: object[], costUsd: number}>} read
   */
  async function scan(member, read) {
    const reason = blockedReason(member);
    if (reason) throw new PhotoLimitError(reason);
    busy.add(member.id);
    let result;
    try {
      result = await read();
    } finally {
      busy.delete(member.id);
    }

    const before = level(usage());
    store.addPhotoScan(member.id, result.costUsd, clock().toISOString());
    const u = usage();
    const crossed = ALERT_LEVELS.filter((l) => before < l && level(u) >= l).pop();
    if (crossed === 100) {
      await alertAdmins(
        `📷 Photo scanning is now *paused for everyone* until next month: ${usd(u.costUsd)} of the ` +
          `${usd(u.budgetUsd)} budget, ${u.photos} of ${u.photoLimit} photos.\n` +
          'To resume sooner, raise PHOTO_MONTHLY_BUDGET_USD or PHOTO_MONTHLY_LIMIT on the server.',
      );
    } else if (crossed) {
      await alertAdmins(
        `📷 Photo scanning has used ${crossed}% of this month's limit: ${usd(u.costUsd)} of the ` +
          `${usd(u.budgetUsd)} budget, ${u.photos} of ${u.photoLimit} photos. It pauses for everyone at 100%.`,
      );
    }
    return result;
  }

  /** Monday-morning summary for admins (called hourly). Skipped in weeks with no photos. */
  async function weeklySummary() {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: settings.timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        hour: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(clock())
        .map((p) => [p.type, p.value]),
    );
    if (parts.weekday !== 'Mon' || Number(parts.hour) < 10) return false;
    const week = `${parts.year}-${parts.month}-${parts.day}`;
    if (store.getMeta('photo_summary_week') === week) return false;
    store.setMeta('photo_summary_week', week);

    const lastWeek = store.photoScansSince(new Date(clock() - 7 * DAY_MS).toISOString());
    if (!lastWeek.photos) return false;
    const u = usage();
    await alertAdmins(
      `📊 Weekly photo scanning check: ${lastWeek.photos} photos last week, costing ${usd(lastWeek.cost)}.\n` +
        `This month so far: ${usd(u.costUsd)} of the ${usd(u.budgetUsd)} budget, ${u.photos} of ${u.photoLimit} photos.`,
    );
    return true;
  }

  return { scan, blockedReason, usage, weeklySummary };
}
