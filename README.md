# isitaurora

Is it Aurora? A daily static page that tells you whether East Midlands
Railway's Sheffield ↔ London St Pancras services are running as Class 810
(Aurora) or Class 222 (Meridian).

## How it works

A single Node 22+ script (`generate.mjs`, no dependencies) that:

1. Exchanges the Realtime Trains v2 refresh token for an access token.
2. Fetches today's and tomorrow's schedule for both directions
   (Sheffield → STP and STP → Sheffield).
3. For each EMR passenger service, scrapes the RTT website for stock
   identification — preferring "Know Your Train" confirmed formation data,
   falling back to the CIF "Pathed as" power type for predictions.
4. Writes `index.html` with client-side filters (date, direction, stock class),
   a machine-readable `data.json` feed, and appends the run to `ledger.csv`.

It tolerates disruption: a day with no services (engineering works, full-line
cancellation, or tomorrow's schedule not yet published) is published as a normal
"no services" result rather than failing the run, and transient API/network
errors are retried before a direction or day is given up on.

## URLs

GitHub Pages serves `main` at the root —
[`tomsmilton.github.io/isitaurora`](https://tomsmilton.github.io/isitaurora/):

| Path | What |
| --- | --- |
| `/` | Live board — today & tomorrow, Aurora vs Meridian |
| `/directory/` | Index of every page (live board + experiments) |
| `/designs/` | Gallery of the design experiments |
| `/designs/01-departure-board.html` | Solari split-flap departure board |
| `/designs/02-boarding-pass.html` | Boarding-pass / ticket stubs |
| `/designs/03-timeline.html` | Day plotted on a time ribbon |
| `/designs/04-big-answer.html` | One giant YES / NO |
| `/designs/05-editorial.html` | Broadsheet rail gazette |
| `/designs/06-dashboard.html` | Stats dashboard |
| `/designs/07-terminal.html` | Static terminal readout |
| `/designs/08-glass.html` | Frosted-glass cards |
| `/designs/09-signage.html` | National Rail signage |
| `/designs/10-journey.html` | Vertical route-map line |
| `/designs/11-terminal-repl.html` | Interactive terminal (type `ls`, `grep`, `next`…) |
| `/data.json` | Machine-readable feed (today + tomorrow) |
| `/ledger.csv` | Full historical log of every observation |
| `/aurora.mjs` | The terminal tool (below) |

## Terminal tool (`aurora`)

A little Node CLI that prints the board in your terminal. It just reads
`/data.json` from the site — **no API token, no dependencies**:

```bash
# run it straight from the web
curl -fsSL https://tomsmilton.github.io/isitaurora/aurora.mjs | node - both

# or save it and run locally
curl -fsSLO https://tomsmilton.github.io/isitaurora/aurora.mjs
node aurora.mjs                # today, Sheffield → London
node aurora.mjs tomorrow both  # tomorrow, both directions
node aurora.mjs next           # just the next departure
node aurora.mjs --stock aurora # only the Class 810s
node aurora.mjs --json | jq    # machine-readable
```

`aurora --help` lists everything. Point it at another feed with
`AURORA_URL=…` or `--url …`.

## Development

```bash
export RTT_API_TOKEN=<your RTT v2 refresh token>
node generate.mjs
open index.html
```

Override the date with `REPORT_DATE=2026-04-25` if you want to check a
different day (today / tomorrow is calculated from UTC).

## Deployment

GitHub Actions runs [.github/workflows/daily.yml](.github/workflows/daily.yml),
generates `index.html`, and commits it to `main`. GitHub Pages serves `main`
at the root, so `index.html` is the site.

One-time setup in the repo:

1. Add `RTT_API_TOKEN` as a repo secret
   (Settings → Secrets and variables → Actions).
2. Enable Pages (Settings → Pages → "Deploy from a branch" → `main` / root).

## Schedule

Cron runs 7×/day — aligned to UK summer time (BST, UTC+1):
06:00, 08:00, 10:00, 15:00, 17:00, 19:00, 22:00.

Because cron runs in UTC and GitHub Actions can't follow DST, in UK winter
these fire one hour earlier local. Adjust the cron expression in the
workflow if it matters.

## Data source

[Realtime Trains](https://www.realtimetrains.co.uk/) — v2 API for the
schedule, website scrape for the "Pathed as" power type and day-of
formation data. Both require an RTT API account.
