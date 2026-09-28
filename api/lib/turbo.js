// Minimal decoder for React Router's turbo-stream payload (the flat array
// streamed into window.__reactRouterContext). Enough for plain loader data.
const CONSTANTS = { "-1": undefined, "-2": undefined, "-3": NaN, "-4": Infinity, "-5": -Infinity, "-6": -0, "-7": null };

export function decodeTurbo(flat) {
  const memo = new Map();
  function dec(i) {
    if (i < 0) return CONSTANTS[String(i)];
    if (memo.has(i)) return memo.get(i);
    const v = flat[i];
    if (Array.isArray(v)) {
      if (typeof v[0] === "string" && v[0].length === 1) {
        const [tag, a] = v;
        if (tag === "D") return new Date(a).toISOString();
        if (tag === "Z" || tag === "P" || tag === "Y") return undefined;
      }
      const out = [];
      memo.set(i, out);
      for (const x of v) out.push(dec(x));
      return out;
    }
    if (v && typeof v === "object") {
      const out = {};
      memo.set(i, out);
      for (const [k, vi] of Object.entries(v)) out[flat[Number(k.slice(1))]] = dec(vi);
      return out;
    }
    return v;
  }
  return dec(0);
}

// Pulls the streamed chunks out of a server-rendered React Router page.
export function extractTurbo(html) {
  const chunks = [...html.matchAll(/streamController\.enqueue\(("(?:[^"\\]|\\.)*")\);/g)].map((m) => JSON.parse(m[1]));
  if (!chunks.length) throw new Error("no turbo-stream payload");
  const firstLine = chunks.join("").split("\n").find((l) => l.trim());
  return decodeTurbo(JSON.parse(firstLine));
}
