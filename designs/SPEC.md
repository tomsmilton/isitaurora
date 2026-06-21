# Design variant spec — "Is it Aurora?"

These are **standalone static design experiments** for the EMR Sheffield ⇄ London
page. Each variant is a single self-contained HTML file in this `designs/` folder
that loads shared sample data and renders client-side.

## What the site answers
East Midlands Railway runs Sheffield ⇄ London St Pancras trains as either a
**Class 810 "Aurora"** (new, electric, the nice one — treat as the highlighted /
"good" answer) or a **Class 222 "Meridian"** (older diesel — secondary). The whole
point is to let someone glance and grok: *is my train an Aurora?*, when it runs,
and whether it's confirmed/predicted/cancelled/late.

## Data contract
Include the data with `<script src="data.js"></script>`. It defines `window.EMR`:

```
EMR = {
  generatedAt: "2026-06-19T16:31:26Z",   // ISO — show this as "data from …"
  today:    { date: "2026-06-19", toLondon: [Service], toSheffield: [Service] },
  tomorrow: { date: "2026-06-20", toLondon: [Service], toSheffield: [Service] },
}
```

`Service` fields:
- `departureTime`, `arrivalTime` — "HH:MM" strings
- `actualDepartureTime`, `actualArrivalTime` — "HH:MM" or null (null = no realtime yet, e.g. tomorrow)
- `departureLatenessMin`, `arrivalLatenessMin` — number or null (0 = on time, +late, -early)
- `origin`, `destination` — station names
- `platform` — string or null
- `cancelled` — boolean
- `stockClass` — "810" | "222" | "unknown"
- `confidence` — "confirmed" | "predicted" | "unknown"
- `stockBranding` — "Aurora" | "Meridian" | null
- `numberOfVehicles` — number or null (coaches)
- `unitNumber` — string or null
- `pathedAs` — raw CIF hint string or null

Helpers: stock label = 810→Aurora, 222→Meridian, else Unknown.

## Every variant MUST make these legible
1. The hero/identity: **Is it Aurora?** + EMR · Sheffield ⇄ London.
2. **When the data is from** — render `generatedAt` in a friendly form ("Updated Fri 19 Jun, 16:31").
3. **Which day** you're looking at (today vs tomorrow) and **which direction**.
4. Per service: dep→arr times, route, **stock (Aurora/Meridian/Unknown) prominent**,
   confidence (confirmed/predicted), cancelled + lateness, and chips for platform/
   coaches/unit when present.
5. Aurora = highlighted, Meridian = secondary, unknown = muted.

Controls (today/tomorrow, direction, stock filter) are encouraged — interactive
toggles with JS — but at minimum the current view must be self-evident.

## Hard requirements
- Self-contained: no external CSS/JS/font CDNs (network is restricted). System fonts only.
- Responsive: must look good at 390px (mobile) and 1180px (desktop).
- Support **both** light and dark via `prefers-color-scheme`.
- Handle the real data volume (33 services/direction) without looking broken.
- Distinct visual identity per the assigned brief — be bold, these are experiments.

## Screenshot harness (USE THIS TO ITERATE)
Puppeteer+Chrome is installed at `/tmp/shotter`. To render a variant:

```
cd /tmp/shotter && node shoot.mjs /home/user/isitaurora/designs/<file>.html /tmp/<name>
```

It writes `/tmp/<name>-{desktop,mobile}-{light,dark}.png`. **Read those PNGs back,
critique your own work, and fix issues — repeat at least twice until it looks
polished.** Check: contrast in both schemes, mobile overflow, alignment, that the
stock identity and "data from" timestamp read clearly.
