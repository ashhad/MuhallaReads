// Badges shown next to members' names, earned by being a good neighbour. Only positive things are shown
// publicly; a late book is shown only to an owner deciding on a request (see borrowerRecord).

export const BADGES = {
  classic: { emoji: '🏛️', name: 'Classic', about: 'A Signed copy, Never overdue and a Bestseller, and a member for 3 months or more.' },
  signed: {
    emoji: '✍️',
    name: 'Signed copy',
    about: 'Verified neighbour: an admin, or two verified neighbours from the same building, confirmed they live there.',
  },
  neverOverdue: { emoji: '📗', name: 'Never overdue', about: 'Has returned 3 or more borrowed books, all on time.' },
  bestseller: { emoji: '📚', name: 'Bestseller', about: 'Has lent 5 or more books to neighbours.' },
  fresh: { emoji: '📰', name: 'Fresh off the press', about: 'Joined in the last 30 days.' },
};

export const BADGE_RULES = {
  freshDays: 30,
  onTimeReturns: 3,
  lends: 5,
  classicDays: 90,
  vouches: 2, // from verified neighbours in the same building
};

/** "✍️ Signed copy · 📗 Never overdue" */
export const badgeLine = (keys) => keys.map((k) => `${BADGES[k].emoji} ${BADGES[k].name}`).join(' · ');
