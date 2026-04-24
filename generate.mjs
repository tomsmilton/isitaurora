// Fetches today's + tomorrow's EMR Sheffield <-> London services from
// Realtime Trains (API + website scrape for stock identification) and writes
// index.html with client-side toggles for date, direction, stock class, order.

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
    timeZone: "UTC",
  });
}

function prettyTimestamp(iso) {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
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

function stockLabel(cls) {
  if (cls === "810") return "Aurora";
  if (cls === "222") return "Meridian";
  return "Unknown";
}

function serviceCard(s, date) {
  const link = s.serviceUid
    ? `${RTT_WEB}/service/gb-nr:${encodeURIComponent(s.serviceUid)}/${date}/detailed`
    : null;
  const cls = `service stock-${s.stockClass} conf-${s.confidence}${s.cancelled ? " cancelled" : ""}`;
  const open = link
    ? `<a class="${cls}" href="${escapeHtml(link)}" target="_blank" rel="noopener">`
    : `<div class="${cls}">`;
  const close = link ? "</a>" : "</div>";

  const metaBits = [];
  if (s.numberOfVehicles) metaBits.push(`${s.numberOfVehicles} coach${s.numberOfVehicles === 1 ? "" : "es"}`);
  if (s.platform) metaBits.push(`Plat ${escapeHtml(s.platform)}`);
  if (s.unitNumber) metaBits.push(`Unit ${escapeHtml(s.unitNumber)}`);

  return `${open}
    <div class="times">
      <span class="dep">${escapeHtml(s.departureTime)}</span>
      <span class="arrow">→</span>
      <span class="arr">${escapeHtml(s.arrivalTime)}</span>
      ${s.cancelled ? `<span class="cancel-tag">Cancelled</span>` : ""}
    </div>
    <div class="route">${escapeHtml(s.origin)} → ${escapeHtml(s.destination)}</div>
    <div class="meta">
      <span class="stock">${escapeHtml(stockLabel(s.stockClass))}</span>
      <span class="conf">${escapeHtml(s.confidence)}</span>
      ${metaBits.length ? `<span class="chips">${metaBits.join(" · ")}</span>` : ""}
    </div>
  ${close}`;
}

function directionPanel(directionKey, title, services, date) {
  const count = (cls) => services.filter((s) => s.stockClass === cls).length;
  const body =
    services.length === 0
      ? `<p class="empty">No EMR services found.</p>`
      : `<div class="summary">
           <span>${services.length} service${services.length === 1 ? "" : "s"}</span>
           <span class="stat"><i class="dot stock-810"></i>${count("810")} Aurora</span>
           <span class="stat"><i class="dot stock-222"></i>${count("222")} Meridian</span>
           ${count("unknown") ? `<span class="stat muted"><i class="dot stock-unknown"></i>${count("unknown")} unknown</span>` : ""}
         </div>
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
  const allEmpty = toLondon.length === 0 && toSheffield.length === 0;
  const emptyNote =
    allEmpty && !error
      ? `<p class="empty">No services published for ${escapeHtml(date)} yet.</p>`
      : "";
  const errorNote = error
    ? `<div class="error">${escapeHtml(error)}</div>`
    : "";

  return `<div data-date-section="${key}" class="date-section">
    <p class="date-heading">
      <span class="date-label">${escapeHtml(dayLabel)}</span>
      <span class="date-long">${escapeHtml(prettyDate(date))}</span>
    </p>
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
<title>EMR Sheffield ⇄ London</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #F5F3EC;
    --surface: #FAF8F1;
    --surface-alt: #EAE7DB;
    --fg: #141413;
    --muted: #6B6A63;
    --subtle: #9A988F;
    --border: #E0DCCC;
    --border-strong: #C5C1AE;
    --ok: #5B8A4A;
    --warn: #B8882F;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1A1916;
      --surface: #22201C;
      --surface-alt: #2C2A24;
      --fg: #EDEBE3;
      --muted: #9F9D94;
      --subtle: #6F6E66;
      --border: #302E27;
      --border-strong: #46443C;
      --ok: #84A878;
      --warn: #D9A444;
    }
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); }
  body {
    margin: 0;
    padding: 0 20px 80px;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, "Segoe UI", Roboto, sans-serif;
    color: var(--fg);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  .wrap { max-width: 960px; margin: 0 auto; position: relative; }
  .updated {
    position: absolute;
    top: 20px; right: 0;
    font-size: 11px;
    color: var(--subtle);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .updated::before {
    content: "";
    width: 6px; height: 6px; border-radius: 999px;
    background: var(--ok);
    opacity: 0.7;
  }
  header { padding: 56px 0 28px; }
  header h1 {
    margin: 0;
    font-size: 15px;
    font-weight: 500;
    letter-spacing: -0.005em;
    color: var(--fg);
  }
  header .sub {
    color: var(--muted);
    font-size: 13px;
    margin-top: 2px;
  }

  .controls {
    position: sticky; top: 0; z-index: 10;
    padding: 10px 0;
    background: color-mix(in srgb, var(--bg) 82%, transparent);
    backdrop-filter: saturate(160%) blur(10px);
    -webkit-backdrop-filter: saturate(160%) blur(10px);
    border-bottom: 1px solid var(--border);
    display: flex; flex-wrap: wrap; gap: 8px;
  }
  .seg {
    display: inline-flex;
    background: var(--surface-alt);
    border-radius: 8px;
    padding: 2px;
  }
  .seg button {
    appearance: none; border: 0; background: transparent;
    color: var(--muted);
    font: inherit; font-size: 13px; font-weight: 500;
    padding: 5px 11px; border-radius: 6px;
    cursor: pointer;
    transition: color 120ms ease, background 120ms ease;
  }
  .seg button:hover { color: var(--fg); }
  .seg button.active {
    background: var(--surface);
    color: var(--fg);
    box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 0 0 0.5px rgba(0,0,0,0.06);
  }
  @media (prefers-color-scheme: dark) {
    .seg button.active { box-shadow: 0 0 0 1px var(--border-strong); }
  }

  main { display: flex; flex-direction: column; }

  .date-section {
    display: flex; flex-direction: column; gap: 44px;
    padding: 40px 0 0;
  }
  .date-heading {
    margin: 0;
    display: flex; align-items: baseline; gap: 10px;
  }
  .date-label {
    font-size: 11px; font-weight: 600;
    letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--subtle);
  }
  .date-long {
    font-size: 13px; color: var(--muted);
  }

  section h3 {
    margin: 0 0 10px;
    font-size: 14px;
    font-weight: 500;
    color: var(--fg);
  }

  .summary {
    display: flex; flex-wrap: wrap; gap: 4px 14px;
    margin: 0 0 16px;
    font-size: 12px; color: var(--muted);
  }
  .summary .stat { display: inline-flex; align-items: center; }
  .summary .stat.muted { color: var(--subtle); }
  .dot {
    display: inline-block; width: 6px; height: 6px;
    border-radius: 999px; margin-right: 6px;
    background: var(--border-strong);
  }
  .dot.stock-810 {
    background: #FFFFFF;
    box-shadow: inset 0 0 0 1px var(--border-strong);
  }
  .dot.stock-222 { background: #141413; }
  @media (prefers-color-scheme: dark) {
    .dot.stock-810 {
      background: #EDEBE3;
      box-shadow: none;
    }
    .dot.stock-222 {
      background: #0A0908;
      box-shadow: inset 0 0 0 1px var(--border);
    }
  }

  .services {
    display: flex; flex-direction: column; gap: 8px;
  }
  .service {
    display: block; text-decoration: none;
    color: var(--fg);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    transition: border-color 120ms ease, transform 80ms ease;
  }
  /* Aurora = light, clean. Meridian = warm stone, a half-step darker than page. */
  .service.stock-810 {
    background: #FFFFFF;
    border-color: #E0DCCC;
  }
  .service.stock-222 {
    background: #DCD6C2;
    border-color: #C9C2A8;
  }
  @media (prefers-color-scheme: dark) {
    .service.stock-810 {
      background: #EDEBE3;
      border-color: #EDEBE3;
      --fg: #141413;
      --muted: #6B6A63;
      --subtle: #9A988F;
      --border-strong: #C5C1AE;
    }
    .service.stock-222 {
      background: #13110F;
      border-color: #2A2822;
    }
  }
  a.service:hover { border-color: var(--border-strong); }
  a.service.stock-810:hover { border-color: #C5C1AE; }
  a.service.stock-222:hover { border-color: #B5AD90; }
  @media (prefers-color-scheme: dark) {
    a.service.stock-810:hover { border-color: #D6D2C2; }
    a.service.stock-222:hover { border-color: #3A382F; }
  }
  a.service:active { transform: translateY(0.5px); }

  .times {
    display: flex; align-items: baseline; gap: 8px;
    font-variant-numeric: tabular-nums;
  }
  .times .dep {
    font-size: 17px; font-weight: 500;
    letter-spacing: -0.01em;
  }
  .times .arrow { color: var(--subtle); font-size: 12px; }
  .times .arr { color: var(--muted); font-size: 13px; }
  .times .cancel-tag {
    margin-left: auto;
    color: var(--warn);
    font-size: 11px; font-weight: 500;
    letter-spacing: 0.04em; text-transform: uppercase;
  }

  .route {
    color: var(--muted); font-size: 12px;
    margin: 2px 0 10px;
  }

  .meta {
    display: flex; flex-wrap: wrap; align-items: center;
    gap: 4px 12px;
    font-size: 12px;
  }
  .meta .stock { font-weight: 500; color: var(--fg); }
  .service.stock-unknown .meta .stock { color: var(--muted); font-weight: 400; }

  .meta .conf {
    font-size: 10px; font-weight: 500;
    letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--subtle);
    display: inline-flex; align-items: center;
  }
  .meta .conf::before {
    content: ""; display: inline-block;
    width: 5px; height: 5px; border-radius: 999px;
    background: var(--border-strong); margin-right: 5px;
  }
  .service.conf-confirmed .meta .conf::before { background: var(--ok); }
  .service.conf-predicted .meta .conf::before { background: var(--warn); }

  .meta .chips { color: var(--muted); }

  .service.cancelled .times .dep,
  .service.cancelled .times .arr,
  .service.cancelled .route,
  .service.cancelled .meta .stock,
  .service.cancelled .meta .chips {
    opacity: 0.45;
  }

  .empty { color: var(--muted); font-size: 13px; margin: 0; }
  .error {
    background: color-mix(in srgb, var(--warn) 8%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--warn) 28%, var(--border));
    color: var(--warn);
    padding: 10px 14px; border-radius: 8px; font-size: 13px;
  }

  footer {
    margin-top: 72px; padding-top: 20px;
    border-top: 1px solid var(--border);
    color: var(--subtle); font-size: 12px;
  }
  footer a { color: var(--muted); text-decoration: underline; text-underline-offset: 2px; }
  footer a:hover { color: var(--fg); }

  /* Filter: date */
  body[data-date="today"] [data-date-section="tomorrow"] { display: none; }
  body[data-date="tomorrow"] [data-date-section="today"] { display: none; }

  /* Filter: direction — always one at a time */
  body[data-direction="to-london"] [data-direction-section="to-sheffield"] { display: none; }
  body[data-direction="to-sheffield"] [data-direction-section="to-london"] { display: none; }

  /* Filter: stock */
  body[data-stock="810"] .service:not(.stock-810) { display: none; }
  body[data-stock="222"] .service:not(.stock-222) { display: none; }
</style>
</head>
<body data-date="today" data-direction="to-london" data-stock="all">
<div class="wrap">
  <div class="updated" title="Page generated ${escapeHtml(generatedAt)}">Updated ${escapeHtml(prettyTimestamp(generatedAt))}</div>
  <header>
    <h1>EMR · Sheffield ⇄ London</h1>
    <div class="sub">Today and tomorrow, with Class 810 (Aurora) vs Class 222 (Meridian) identification.</div>
  </header>
  <nav class="controls" aria-label="Display controls">
    <div class="seg" role="tablist" aria-label="Date">
      <button data-control="date" data-value="today">Today</button>
      <button data-control="date" data-value="tomorrow">Tomorrow</button>
    </div>
    <div class="seg" role="tablist" aria-label="Direction">
      <button data-control="direction" data-value="to-london">Sheff → London</button>
      <button data-control="direction" data-value="to-sheffield">London → Sheff</button>
    </div>
    <div class="seg" role="tablist" aria-label="Stock">
      <button data-control="stock" data-value="all">All</button>
      <button data-control="stock" data-value="810">Aurora</button>
      <button data-control="stock" data-value="222">Meridian</button>
    </div>
  </nav>
  <main>
    ${datePage("today", "Today", today)}
    ${datePage("tomorrow", "Tomorrow", tomorrow)}
  </main>
  <footer>
    Data from <a href="https://www.realtimetrains.co.uk/" target="_blank" rel="noopener">Realtime Trains</a>.
  </footer>
</div>
<script>
(function () {
  var keys = ["date", "direction", "stock"];
  var defaults = { date: "today", direction: "to-london", stock: "all" };
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
        var on = btn.getAttribute("data-value") === state[k];
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-selected", on ? "true" : "false");
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
