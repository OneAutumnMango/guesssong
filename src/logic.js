export const scoreFor = (correct, elapsedMs, durationMs = 20000) =>
  correct ? Math.round(1000 - 500 * Math.min(Math.max(0, elapsedMs) / durationMs, 1)) : 0;

export const perPlayerCount = (total, playerCount, poolSizes) =>
  Math.min(Math.floor(total / playerCount), ...poolSizes);

export function pickTracks(pools, perPlayer, rng = Math.random) {
  const taken = new Set();
  const out = {};
  for (const [player, pool] of Object.entries(pools)) {
    const a = [...pool];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    out[player] = [];
    for (const t of a) {
      if (out[player].length >= perPlayer) break;
      if (taken.has(t.id)) continue;
      taken.add(t.id);
      out[player].push(t);
    }
  }
  return out;
}
