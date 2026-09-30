/** Spot-check censor / reveal against the dev UI proxy or the API origin. */
const base = process.env.BASE || 'http://localhost:5173';

async function json(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const health = await json(`${base}/api/health`);
assert(health.ok, health.error || 'health failed');

for (const symbol of ['ES', 'NQ']) {
  for (const playTf of ['5m', '1h']) {
    const round = await json(`${base}/api/round/next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, playTf }),
    });
    const T = round.cutoff;
    for (const tf of ['1m', '5m', '15m', '1h', '1d']) {
      const { bars } = await json(
        `${base}/api/bars?symbol=${symbol}&tf=${tf}&cutoff=${T}&limit=100`,
      );
      assert(bars.length > 0, `${symbol} ${playTf}/${tf}: empty`);
      assert(
        bars.every((b) => b.t < T || tf === '1d'),
        // opens can equal T only if barEnd<=T which for intraday means open < T
        `${symbol} ${tf}: open>=T`,
      );
      // stricter: last bar open < T for intraday
      if (tf !== '1d') {
        assert(bars[bars.length - 1].t < T, `${symbol} ${tf}: last open not before T`);
      }
    }
    const reveal = await json(`${base}/api/round/reveal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roundId: round.roundId, predicted: 'up' }),
    });
    assert(reveal.nextBar.t === T, 'revealed bar open !== cutoff');
    assert(reveal.nextBar.c !== reveal.nextBar.o, 'doji leaked into pool');
    const { bars: after } = await json(
      `${base}/api/bars?symbol=${symbol}&tf=${playTf}&cutoff=${reveal.meta.nextBarEnd}&limit=20`,
    );
    assert(
      after.some((b) => b.t === T),
      'revealed play bar missing after reveal',
    );
    console.log(`OK ${symbol} ${playTf} T=${T} actual=${reveal.actual}`);
  }
}
console.log('All leak checks passed.');
