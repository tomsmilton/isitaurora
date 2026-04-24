// Fetches today's + tomorrow's EMR Sheffield <-> London services from
// Realtime Trains (API + website scrape for stock identification) and writes
// index.html with client-side toggles for date, direction filter, and order.

import { writeFile } from "node:fs/promises";

const RTT_API = "https://data.rtt.io";
const RTT_WEB = "https://www.realtimetrains.co.uk";
const EMR_OPERATOR = "EM";
const SHEFFIELD = "SHF";
const ST_PANCRAS = "STP";
const MAX_CONCURRENT_SCRAPES = 6;

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function prettyDate(ymd) {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function parseIsoTime(iso) {
  if (!iso) return "—";
  const m = iso.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : "—";
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function getAccessToken() {
  const refresh = process.env.RTT_API_TOKEN;
  if (!refresh) throw new Error("RTT_API_TOKEN env var is required");

  const res = await fetch(`${RTT_API}/api/get_access_token`, {
    headers: { Authorization: `Bearer ${refresh}` },
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const token = data.token ?? data.access_token;
  if (!token) throw new Error("No access token in RTT response");
  return token;
}

async function searchServices(token, origin, dest, date) {
  const url = new URL("/gb-nr/location", RTT_API);
  url.searchParams.set("code", origin);
  url.searchParams.set("filterTo", dest);
  url.searchParams.set("timeFrom", `${date}T00:00:00Z`);
  url.searchParams.set("timeTo", `${date}T23:59:00Z`);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `Search ${origin}->${dest} ${date} failed: ${res.status} ${res.statusText}`
    );
  }
  const data = await res.json();
  return data.services ?? [];
}

function parseStockFromHtml(html) {
  // Confirmed formation with unit number: "Aurora 5-coach train (unit 810010)"
  let m = html.match(
    /(Aurora|Meridian)\s+(\d+)-coach\s+train\s*\(unit\s+(\d+)\)/i
  );
  if (m) {
    const brand = m[1];
    const is810 = brand.toLowerCase() === "aurora" || m[3].startsWith("810");
    return {
      stockClass: is810 ? "810" : "222",
      confidence: "confirmed",
      stockBranding: brand,
      numberOfVehicles: Number.parseInt(m[2]),
      unitNumber: m[3],
    };
  }

  // Confirmed formation without unit: "Meridian (5 coaches)"
  m = html.match(/(Aurora|Meridian)\s*\((\d+)\s*coaches?\)/i);
  if (m) {
    const brand = m[1];
    return {
      stockClass: brand.toLowerCase() === "aurora" ? "810" : "222",
      confidence: "confirmed",
      stockBranding: brand,
      numberOfVehicles: Number.parseInt(m[2]),
    };
  }

  // Predicted via CIF "Pathed as" power type
  const pathedMatches = [...html.matchAll(/Pathed as\s+([^<"]+)/gi)].map((p) =>
    p[1].trim()
  );
  const pathedAs = pathedMatches.join(" | ") || undefined;

  for (const p of pathedMatches) {
    if (/class\s*810/i.test(p) || /electro.?diesel/i.test(p)) {
      return { stockClass: "810", confidence: "predicted", pathedAs };
    }
  }
  for (const p of pathedMatches) {
    if (/diesel\s+multiple\s+unit/i.test(p)) {
      return { stockClass: "222", confidence: "predicted", pathedAs };
    }
  }
  return { stockClass: "unknown", confidence: "unknown", pathedAs };
}

async function scrapeStock(serviceIdentity, date) {
  const url = `${RTT_WEB}/service/gb-nr:${serviceIdentity}/${date}/detailed`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "text/html",
        "User-Agent": "EMRDailyReport/1.0 (personal use)",
      },
    });
    if (!res.ok) return { stockClass: "unknown", confidence: "unknown" };
    return parseStockFromHtml(await res.text());
  } catch {
    return { stockClass: "unknown", confidence: "unknown" };
  }
}

// Bounded parallelism for website scrapes (RTT rate-limits above ~6 in flight).
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function pump() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
  return results;
}

function enrichService(entry, stock) {
  const sched = entry.scheduleMetadata ?? {};
  const temporal = entry.temporalData ?? {};
  const locMeta = entry.locationMetadata ?? {};
  const dep = temporal.departure ?? {};
  return {
    serviceUid: sched.identity ?? sched.uniqueIdentity ?? "",
    departureTime: parseIsoTime(dep.scheduleAdvertised ?? dep.scheduleInternal),
    arrivalTime: parseIsoTime(
      entry.destination?.[0]?.temporalData?.scheduleAdvertised ??
        entry.destination?.[0]?.temporalData?.scheduleInternal
    ),
    origin: entry.origin?.[0]?.location?.description ?? "",
    destination: entry.destination?.[0]?.location?.description ?? "",
    platform: locMeta.platform?.forecast ?? locMeta.platform?.planned,
    cancelled:
      dep.isCancelled === true || temporal.displayAs === "CANCELLED_CALL",
    ...stock,
  };
}

async function fetchDirection(token, origin, dest, date) {
  const raw = await searchServices(token, origin, dest, date);
  const entries = raw.filter((e) => {
    const m = e.scheduleMetadata;
    return m?.operator?.code === EMR_OPERATOR && m?.inPassengerService === true;
  });
  const stocks = await mapWithConcurrency(
    entries,
    MAX_CONCURRENT_SCRAPES,
    async (e) => {
      const id =
        e.scheduleMetadata?.identity ?? e.scheduleMetadata?.uniqueIdentity;
      if (!id) return { stockClass: "unknown", confidence: "unknown" };
      return scrapeStock(id, date);
    }
  );
  return entries
    .map((e, i) => enrichService(e, stocks[i]))
    .sort((a, b) => a.departureTime.localeCompare(b.departureTime));
}

async function fetchDay(token, date) {
  try {
    const [toLondon, toSheffield] = await Promise.all([
      fetchDirection(token, SHEFFIELD, ST_PANCRAS, date),
      fetchDirection(token, ST_PANCRAS, SHEFFIELD, date),
    ]);
    return { date, toLondon, toSheffield };
  } catch (err) {
    return {
      date,
      toLondon: [],
      toSheffield: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function serviceCard(s, date) {
  const label =
    s.stockClass === "810"
      ? "Class 810 Aurora"
      : s.stockClass === "222"
      ? "Class 222 Meridian"
      : "Unknown";
  const link = s.serviceUid
    ? `${RTT_WEB}/service/gb-nr:${encodeURIComponent(s.serviceUid)}/${date}/detailed`
    : null;
  const cls = `service stock-${s.stockClass} conf-${s.confidence}${s.cancelled ? " cancelled" : ""}`;
  const open = link
    ? `<a class="${cls}" href="${escapeHtml(link)}" target="_blank" rel="noopener">`
    : `<div class="${cls}">`;
  const close = link ? "</a>" : "</div>";

  return `${open}
    <div class="times">
      <span class="dep">${escapeHtml(s.departureTime)}</span>
      <span class="arrow">→</span>
      <span class="arr">${escapeHtml(s.arrivalTime)}</span>
    </div>
    <div class="route">${escapeHtml(s.origin)} → ${escapeHtml(s.destination)}</div>
    <div class="meta">
      <span class="stock-badge">${escapeHtml(label)}</span>
      <span class="conf-badge">${escapeHtml(s.confidence)}</span>
      ${s.numberOfVehicles ? `<span class="coaches">${s.numberOfVehicles} coaches</span>` : ""}
      ${s.unitNumber ? `<span class="unit">Unit ${escapeHtml(s.unitNumber)}</span>` : ""}
      ${s.platform ? `<span class="platform">Plat ${escapeHtml(s.platform)}</span>` : ""}
      ${s.cancelled ? `<span class="cancel">CANCELLED</span>` : ""}
    </div>
  ${close}`;
}

function directionPanel(directionKey, title, services, date) {
  const count = (cls) => services.filter((s) => s.stockClass === cls).length;
  const body =
    services.length === 0
      ? `<p class="empty">No EMR services found.</p>`
      : `<p class="summary">
           ${services.length} service${services.length === 1 ? "" : "s"} ·
           <span class="pill stock-810">${count("810")} Class 810</span>
           <span class="pill stock-222">${count("222")} Class 222</span>
           <span class="pill stock-unknown">${count("unknown")} unknown</span>
         </p>
         <div class="services">${services
           .map((s) => serviceCard(s, date))
           .join("\n")}</div>`;

  return `<section data-direction-section="${directionKey}">
    <h3>${escapeHtml(title)}</h3>
    ${body}
  </section>`;
}

function datePage(key, dayLabel, dayData) {
  const { date, toLondon, toSheffield, error } = dayData;
  const dateLine = `${dayLabel} — ${prettyDate(date)}`;
  const allEmpty = toLondon.length === 0 && toSheffield.length === 0;
  const emptyNote =
    allEmpty && !error
      ? `<p class="empty">No services published for ${escapeHtml(date)} yet.</p>`
      : "";
  const errorNote = error
    ? `<div class="error">${escapeHtml(error)}</div>`
    : "";

  return `<div data-date-section="${key}" class="date-section">
    <h2 class="date-heading">${escapeHtml(dateLine)}</h2>
    ${errorNote}
    ${emptyNote}
    ${directionPanel("to-london", "Sheffield → London St Pancras", toLondon, date)}
    ${directionPanel("to-sheffield", "London St Pancras → Sheffield", toSheffield, date)}
  </div>`;
}

function renderHtml(today, tomorrow, generatedAt) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EMR Sheffield ↔ London</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f7f8;
    --fg: #111;
    --muted: #666;
    --card: #fff;
    --border: #e3e3e8;
    --accent: #0f172a;
    --stock-810: #2563eb;
    --stock-222: #dc2626;
    --stock-unknown: #6b7280;
    --conf-confirmed: #059669;
    --conf-predicted: #d97706;
    --conf-unknown: #6b7280;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f0f12;
      --fg: #e8e8ea;
      --muted: #9a9aa2;
      --card: #181820;
      --border: #2a2a33;
      --accent: #e8e8ea;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 1rem 3rem;
    background: var(--bg); color: var(--fg);
    font: 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  header {
    max-width: 960px; margin: 0 auto; padding: 2rem 0 1rem;
  }
  header h1 { margin: 0; font-size: 1.5rem; }
  .controls {
    position: sticky; top: 0; z-index: 10;
    max-width: 960px; margin: 0 auto;
    padding: .75rem 0;
    background: color-mix(in srgb, var(--bg) 85%, transparent);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--border);
    display: flex; flex-wrap: wrap; gap: .5rem 1rem;
  }
  .control-group {
    display: inline-flex; border: 1px solid var(--border);
    border-radius: 8px; overflow: hidden;
    background: var(--card);
  }
  .control-group button {
    appearance: none; border: 0; background: transparent;
    color: var(--muted); font: inherit; font-size: .85rem;
    padding: .4rem .7rem; cursor: pointer;
    border-right: 1px solid var(--border);
  }
  .control-group button:last-child { border-right: 0; }
  .control-group button:hover { color: var(--fg); }
  .control-group button.active {
    background: var(--accent); color: var(--bg); font-weight: 500;
  }
  .control-label {
    font-size: .75rem; color: var(--muted);
    align-self: center; letter-spacing: .04em; text-transform: uppercase;
  }
  main { max-width: 960px; margin: 0 auto; }
  .date-section {
    display: flex; flex-direction: column; gap: 2rem;
    margin-top: 2rem;
  }
  .date-heading {
    margin: 0; font-size: 1.15rem; color: var(--muted); font-weight: 500;
  }
  section h3 { margin: 0 0 .5rem; font-size: 1.05rem; }

  /* Order by "first direction" selection */
  [data-direction-section="to-london"] { order: 1; }
  [data-direction-section="to-sheffield"] { order: 2; }
  body[data-first="to-sheffield"] [data-direction-section="to-sheffield"] { order: 1; }
  body[data-first="to-sheffield"] [data-direction-section="to-london"] { order: 2; }

  /* Date tabs: show one */
  body[data-date="today"] [data-date-section="tomorrow"] { display: none; }
  body[data-date="tomorrow"] [data-date-section="today"] { display: none; }

  /* Direction filter: hide the non-selected one (both = show both) */
  body[data-direction="to-london"] [data-direction-section="to-sheffield"] { display: none; }
  body[data-direction="to-sheffield"] [data-direction-section="to-london"] { display: none; }

  /* "First" control is meaningless when only one direction is visible */
  body[data-direction="to-london"] [data-first-group],
  body[data-direction="to-sheffield"] [data-first-group] {
    opacity: .4; pointer-events: none;
  }

  .summary { color: var(--muted); margin: 0 0 1rem; font-size: .9rem; }
  .pill {
    display: inline-block; padding: .1rem .5rem; border-radius: 999px;
    font-size: .8rem; font-weight: 500; margin-right: .25rem;
    border: 1px solid var(--border);
  }
  .pill.stock-810 { color: var(--stock-810); border-color: var(--stock-810); }
  .pill.stock-222 { color: var(--stock-222); border-color: var(--stock-222); }
  .pill.stock-unknown { color: var(--stock-unknown); }
  .services {
    display: grid; gap: .6rem;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  }
  .service {
    display: block; text-decoration: none; color: inherit;
    background: var(--card); border: 1px solid var(--border);
    border-left: 4px solid var(--stock-unknown);
    padding: .75rem .9rem; border-radius: 8px;
    transition: border-color .15s, transform .05s;
  }
  a.service:hover { border-color: var(--fg); }
  a.service:active { transform: translateY(1px); }
  .service.stock-810 { border-left-color: var(--stock-810); }
  .service.stock-222 { border-left-color: var(--stock-222); }
  .service.cancelled { opacity: .55; text-decoration: line-through; }
  .times {
    font-variant-numeric: tabular-nums;
    font-size: 1.1rem; font-weight: 600;
    display: flex; gap: .5rem; align-items: center;
  }
  .arrow { color: var(--muted); font-weight: 400; }
  .route { color: var(--muted); font-size: .85rem; margin: .15rem 0 .5rem; }
  .meta { display: flex; flex-wrap: wrap; gap: .35rem; font-size: .8rem; }
  .meta span {
    padding: .1rem .45rem; border-radius: 4px;
    background: color-mix(in srgb, var(--fg) 7%, transparent);
  }
  .stock-badge { font-weight: 500; }
  .service.stock-810 .stock-badge { color: var(--stock-810); }
  .service.stock-222 .stock-badge { color: var(--stock-222); }
  .conf-badge { text-transform: uppercase; font-size: .7rem; letter-spacing: .04em; }
  .service.conf-confirmed .conf-badge { color: var(--conf-confirmed); }
  .service.conf-predicted .conf-badge { color: var(--conf-predicted); }
  .service.conf-unknown .conf-badge { color: var(--conf-unknown); }
  .cancel { color: var(--stock-222); font-weight: 600; }
  .empty { color: var(--muted); font-style: italic; }
  .error {
    background: color-mix(in srgb, var(--stock-222) 15%, transparent);
    border: 1px solid var(--stock-222); color: var(--stock-222);
    padding: .6rem .9rem; border-radius: 8px;
  }
  footer {
    max-width: 960px; margin: 2rem auto 0; padding-top: 1rem;
    color: var(--muted); font-size: .8rem;
    border-top: 1px solid var(--border);
  }
  footer a { color: inherit; }
</style>
</head>
<body data-date="today" data-direction="both" data-first="to-london">
<header>
  <h1>EMR Sheffield ↔ London</h1>
</header>
<nav class="controls" aria-label="Display controls">
  <div class="control-group" role="tablist" aria-label="Date">
    <button data-control="date" data-value="today">Today</button>
    <button data-control="date" data-value="tomorrow">Tomorrow</button>
  </div>
  <div class="control-group" role="tablist" aria-label="Direction filter">
    <button data-control="direction" data-value="both">Both</button>
    <button data-control="direction" data-value="to-london">To London</button>
    <button data-control="direction" data-value="to-sheffield">To Sheffield</button>
  </div>
  <div class="control-group" data-first-group role="tablist" aria-label="Order">
    <button data-control="first" data-value="to-london">Sheff → London first</button>
    <button data-control="first" data-value="to-sheffield">London → Sheff first</button>
  </div>
</nav>
<main>
  ${datePage("today", "Today", today)}
  ${datePage("tomorrow", "Tomorrow", tomorrow)}
</main>
<footer>
  Generated ${escapeHtml(generatedAt)} from
  <a href="https://www.realtimetrains.co.uk/" target="_blank" rel="noopener">Realtime Trains</a>.
  Stock predictions use CIF "Pathed as" power type; "confirmed" means Know Your Train formation data is available.
</footer>
<script>
(function () {
  var keys = ["date", "direction", "first"];
  var defaults = { date: "today", direction: "both", first: "to-london" };
  var state = {};
  keys.forEach(function (k) {
    var v = null;
    try { v = localStorage.getItem("emr-" + k); } catch (e) {}
    state[k] = v || defaults[k];
  });

  function apply() {
    keys.forEach(function (k) {
      document.body.setAttribute("data-" + k, state[k]);
      document.querySelectorAll('[data-control="' + k + '"]').forEach(function (btn) {
        btn.classList.toggle("active", btn.getAttribute("data-value") === state[k]);
        btn.setAttribute("aria-selected", btn.getAttribute("data-value") === state[k] ? "true" : "false");
      });
    });
  }

  document.querySelectorAll("[data-control]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var k = btn.getAttribute("data-control");
      var v = btn.getAttribute("data-value");
      state[k] = v;
      try { localStorage.setItem("emr-" + k, v); } catch (e) {}
      apply();
    });
  });

  apply();
})();
</script>
</body>
</html>
`;
}

async function main() {
  const todayDate = process.env.REPORT_DATE || todayYmd();
  const tomorrowDate = addDays(todayDate, 1);
  const generatedAt = new Date().toISOString();

  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const empty = { toLondon: [], toSheffield: [], error: msg };
    const html = renderHtml(
      { ...empty, date: todayDate },
      { ...empty, date: tomorrowDate },
      generatedAt
    );
    await writeFile("index.html", html, "utf8");
    console.error("Token failure:", msg);
    process.exit(1);
  }

  const [today, tomorrow] = await Promise.all([
    fetchDay(token, todayDate),
    fetchDay(token, tomorrowDate),
  ]);

  console.log(
    `Today ${todayDate}: ${today.toLondon.length}↓ ${today.toSheffield.length}↑${today.error ? ` (error: ${today.error})` : ""}`
  );
  console.log(
    `Tomorrow ${tomorrowDate}: ${tomorrow.toLondon.length}↓ ${tomorrow.toSheffield.length}↑${tomorrow.error ? ` (error: ${tomorrow.error})` : ""}`
  );

  const html = renderHtml(today, tomorrow, generatedAt);
  await writeFile("index.html", html, "utf8");
  console.log(`Wrote index.html (${html.length} bytes)`);

  const hadAnyData =
    today.toLondon.length +
      today.toSheffield.length +
      tomorrow.toLondon.length +
      tomorrow.toSheffield.length >
    0;
  if (!hadAnyData) process.exit(1);
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
