// US units and formats everywhere: miles / feet, "Oct 10", "9 PM".
export const fmtDist = (mi: number) => (mi < 0.1 ? `${Math.max(10, Math.round((mi * 5280) / 10) * 10)} ft` : `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`);

export const fmtDate = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

export const fmtHour = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;

export const fmtAgo = (t: number) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

// "Fight No Weapon call, 16th St & Hoff St" -> "16th St & Hoff St"
export const placeOf = (desc: string) => {
  const i = desc.lastIndexOf(", ");
  const s = i >= 0 ? desc.slice(i + 2) : desc;
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\s+/g, " ").trim();
};

// Busiest 3-hour window, e.g. "9 PM–12 AM".
export const peakWindow = (hours: number[]) => {
  if (!hours.length) return "";
  const n = new Array(24).fill(0);
  for (const h of hours) n[h]++;
  let best = 0, bestSum = -1;
  for (let h = 0; h < 24; h++) {
    const s = n[h] + n[(h + 1) % 24] + n[(h + 2) % 24];
    if (s > bestSum) [best, bestSum] = [h, s];
  }
  return `${fmtHour(best)}–${fmtHour((best + 3) % 24)}`;
};
