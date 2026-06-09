// Tiny formatting helpers shared across pages (display + controller), so the
// race readouts on the big screen and the phones can't drift apart.

// English ordinal for a place: 1 → "1st", 2 → "2nd", 3 → "3rd", 11 → "11th".
export function ordinal(n) {
  const t = n % 100, u = n % 10;
  const suffix = (t >= 11 && t <= 13) ? 'th' : (u === 1 ? 'st' : u === 2 ? 'nd' : u === 3 ? 'rd' : 'th');
  return `${n}${suffix}`;
}
