#!/usr/bin/env node
// aurora — is it Aurora? A little terminal tool that prints today's and
// tomorrow's EMR Sheffield ⇄ London services and whether each runs as a
// Class 810 "Aurora" (electric) or a Class 222 "Meridian" (diesel).
//
// It just reads the published feed from the website — no API key, no deps:
//
//   node aurora.mjs                 # today, Sheffield → London
//   node aurora.mjs both            # both directions
//   node aurora.mjs tomorrow        # tomorrow
//   node aurora.mjs next            # only the next departure
//   node aurora.mjs --stock aurora  # only the Class 810s
//   node aurora.mjs --json | jq     # machine-readable
//
// One-liner (no download):
//   curl -fsSL https://tomsmilton.github.io/isitaurora/aurora.mjs | node - both
//
// Point at a different feed with AURORA_URL=... or --url ...

const DEFAULT_URL = "https://tomsmilton.github.io/isitaurora/data.json";

// ---- args --------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { date: "today", dir: "to-london", stock: "all", next: false, json: false, color: null, url: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], l = a.toLowerCase();
  if (a === "--help" || a === "-h") opts.help = true;
  else if (a === "--json") opts.json = true;
  else if (a === "--next" || a === "-n") opts.next = true;
  else if (a === "--no-color") opts.color = false;
  else if (a === "--color") opts.color = true;
  else if (a === "--url") opts.url = argv[++i];
  else if (a.startsWith("--url=")) opts.url = a.slice(6);
  else if (a === "--dir") opts.dir = normDir(argv[++i]);
  else if (a.startsWith("--dir=")) opts.dir = normDir(a.slice(6));
  else if (a === "--stock" || a === "-s") opts.stock = normStock(argv[++i]);
  else if (a.startsWith("--stock=")) opts.stock = normStock(a.slice(8));
  else if (a === "--date" || a === "-d") opts.date = argv[++i];
  // friendly positionals: `aurora tomorrow both aurora next`
  else if (["today", "tomorrow"].includes(l)) opts.date = l;
  else if (l === "next") opts.next = true;
  else if (/^(lon|london|to-?london|stp|shf|sheff|sheffield|to-?sheffield|both)$/.test(l)) opts.dir = normDir(l);
  else if (["all", "810", "aurora", "222", "meridian"].includes(l)) opts.stock = normStock(l);
  else { console.error(`aurora: unknown argument "${a}" — try --help`); process.exit(2); }
}
function normDir(v) {
  const l = String(v || "").toLowerCase();
  if (/^(s|shf|sheff|sheffield|to-?sheffield)$/.test(l)) return "to-sheffield";
  if (l === "both") return "both";
  return "to-london";
}
function normStock(v) {
  const l = String(v || "").toLowerCase();
  if (l === "810" || l === "aurora") return "810";
  if (l === "222" || l === "meridian") return "222";
  return "all";
}

if (opts.help) {
  console.log(`aurora — is it Aurora?  (EMR Sheffield ⇄ London St Pancras)

Reads the published feed — no API key needed.

Usage: aurora [date] [direction] [stock] [options]

  date         today (default) · tomorrow
  direction    london (default) · sheffield · both
  stock        all (default) · aurora|810 · meridian|222

Options
  -n, --next        only the next upcoming departure
      --json        print the raw feed JSON (implies --no-color)
      --no-color    disable ANSI colour
      --url URL     feed URL (default: ${DEFAULT_URL})
  -h, --help        this help

Examples
  aurora                     today, Sheffield → London
  aurora tomorrow both       tomorrow, both directions
  aurora next                the next departure and whether it's an Aurora
  aurora --json | jq '.today.toLondon[].stockClass'`);
  process.exit(0);
}

// ---- colour ------------------------------------------------------------
const useColor =
  opts.color !== false && !opts.json &&
  (opts.color === true || (process.stdout.isTTY && !process.env.NO_COLOR));
const sgr = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const C = {
  green: (s) => sgr("32", s), yellow: (s) => sgr("33", s), red: (s) => sgr("31", s),
  cyan: (s) => sgr("36", s), dim: (s) => sgr("2", s), bold: (s) => sgr("1", s), ul: (s) => sgr("4", s),
};

// ---- helpers -----------------------------------------------------------
const DIR_LABEL = {
  "to-london": "Sheffield → London St Pancras",
  "to-sheffield": "London St Pancras → Sheffield",
};
const stockLabel = (c) => (c === "810" ? "Aurora" : c === "222" ? "Meridian" : "Unknown");
const pad = (s, n) => { s = String(s ?? ""); return s.length >= n ? s : s + " ".repeat(n - s.length); };
const toMin = (t) => { const m = String(t).match(/(\d{2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : 0; };
function prettyDate(ymd) {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-GB",
    { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}
function prettyStamp(iso) {
  return new Date(iso).toLocaleString("en-GB",
    { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}
function ageStr(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
function stockColor(s) {
  if (s.cancelled) return C.red;
  if (s.stockClass === "810") return C.green;
  if (s.stockClass === "222") return C.yellow;
  return C.dim;
}
function statusText(s) {
  if (s.cancelled) return C.red("CANCELLED");
  if (s.confidence === "predicted") return C.dim("predicted");
  const late = s.arrivalLatenessMin ?? s.departureLatenessMin;
  if (s.actualDepartureTime == null && late == null) return C.dim("expected");
  if (late == null || late === 0) return C.green("on time");
  if (late > 0) return C.yellow(`+${late}m late`);
  return C.green(`${-late}m early`);
}

function printDirection(label, services) {
  if (opts.stock !== "all") services = services.filter((s) => s.stockClass === opts.stock);
  console.log(C.bold(label) + C.dim(`  ·  ${services.length} service${services.length === 1 ? "" : "s"}`));
  if (!services.length) {
    console.log("  " + C.dim("no services — likely engineering works or disruption"));
    console.log("");
    return;
  }
  console.log(C.dim("  " + pad("DEP", 6) + pad("ARR", 8) + pad("PLAT", 6) + pad("STOCK", 16) + "STATUS"));
  for (const s of services) {
    const col = stockColor(s);
    const cls = s.stockClass === "unknown" ? "—" : s.stockClass;
    const dot = s.stockClass === "unknown" ? "○" : "●";
    const dep = (s.cancelled ? C.dim : C.bold)(pad(s.departureTime, 6));
    const arr = C.dim(pad("→" + s.arrivalTime, 8));
    const plat = pad(s.platform || "—", 6);
    const stock = col(pad(`${dot} ${cls} ${stockLabel(s.stockClass)}`, 16));
    console.log("  " + dep + arr + plat + stock + statusText(s));
  }
  const n810 = services.filter((s) => s.stockClass === "810" && !s.cancelled).length;
  const n222 = services.filter((s) => s.stockClass === "222" && !s.cancelled).length;
  const nCan = services.filter((s) => s.cancelled).length;
  const bits = [C.green(`${n810} Aurora`), C.yellow(`${n222} Meridian`)];
  if (nCan) bits.push(C.red(`${nCan} cancelled`));
  const verdict = n810 > n222 ? C.green("✔ mostly Aurora ⚡") : n810 > 0 ? C.yellow("~ mixed fleet") : C.yellow("✘ all Meridian");
  console.log("  " + bits.join(C.dim(" · ")) + "   " + verdict);
  console.log("");
}

function printNext(services) {
  const now = new Date();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  let pool = services.filter((s) => !s.cancelled);
  if (opts.stock !== "all") pool = pool.filter((s) => s.stockClass === opts.stock);
  const s = pool.find((x) => toMin(x.departureTime) >= nowMin) || pool[0];
  if (!s) { console.log(C.dim("no upcoming departures on this view.")); return; }
  const isA = s.stockClass === "810";
  const verdict = isA ? C.green("● it's a Class 810 Aurora ⚡")
    : s.stockClass === "222" ? C.yellow("● it's a Class 222 Meridian") : C.dim("○ stock unknown");
  console.log(`  ${C.bold(s.departureTime)} ${C.dim("→ " + s.arrivalTime)}  ${s.origin} → ${s.destination}`);
  console.log(`  ${verdict}  ${C.dim(s.confidence + (s.platform ? ` · plat ${s.platform}` : "") + (s.numberOfVehicles ? ` · ${s.numberOfVehicles} coaches` : ""))}`);
}

// ---- main --------------------------------------------------------------
async function main() {
  const url = opts.url || process.env.AURORA_URL || DEFAULT_URL;
  let feed;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    feed = await res.json();
  } catch (err) {
    console.error(C.red("Could not fetch the feed: ") + (err?.message || err) + C.dim(`\n(${url})`));
    process.exit(1);
  }

  if (opts.json) { console.log(JSON.stringify(feed, null, 2)); return; }

  const day = feed[opts.date];
  if (!day) { console.error(C.red(`feed has no "${opts.date}" — try today or tomorrow`)); process.exit(2); }
  const dirs = opts.dir === "both" ? ["to-london", "to-sheffield"] : [opts.dir];
  const pick = (d) => (d === "to-london" ? day.toLondon : day.toSheffield) || [];

  const route = dirs.length > 1 ? "Sheffield ⇄ London St Pancras" : DIR_LABEL[dirs[0]];
  console.log("");
  console.log(C.bold("Is it Aurora?") + C.dim(`  ·  EMR ${route}`));
  console.log(C.dim(`${opts.date}, ${prettyDate(day.date)}  ·  data ${prettyStamp(feed.generatedAt)} (${ageStr(feed.generatedAt)})`));
  console.log("");
  if (day.error) console.log(C.yellow("⚠ " + day.error) + "\n");

  if (opts.next) { printNext(pick(dirs[0])); console.log(""); return; }
  for (const d of dirs) printDirection(DIR_LABEL[d], pick(d));
  console.log(C.dim("data: Realtime Trains via " + C.ul("tomsmilton.github.io/isitaurora")));
}

main().catch((err) => { console.error(C.red("Unhandled error: ") + (err?.message || err)); process.exit(1); });
