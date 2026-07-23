# Box tracker

A small dashboard showing where each of our moving boxes is, so family can check
without hunting through FedEx.

**Live page:** https://mv2731.github.io/box-tracker/

Six boxes shipped Brooklyn, NY to Sunnyvale, CA (Google Desktop Shipping request
672473, forwarded by Kingsley on 19 Jul 2026).

## How it works

`scripts/fetch-tracking.mjs` reads `packages.json`, fetches each package's public
EasyPost tracking page, and writes `docs/data/tracking.json`. The dashboard in
`docs/index.html` is a static page that reads that JSON.

No API key is involved. The EasyPost tracking pages server-render the full tracker
object (status, estimated delivery, and every carrier scan) into the page's
Next.js payload, so the script parses it straight out of the HTML.

A GitHub Actions workflow re-runs the script every 30 minutes and commits the JSON
when anything changed. GitHub Pages serves `docs/` from `main`, so a committed
change is live within a minute or so.

## Adding or renaming a box

Edit `packages.json` and push. Each entry needs a `nickname`, the `trackingCode`,
and the `trackerUrl` from the shipping email:

```json
{
  "nickname": "Kitchen stuff",
  "trackingCode": "874585479240",
  "trackerUrl": "https://track.easypost.com/…"
}
```

The `nickname` is what shows on the dashboard, so name boxes by what's in them if
that's more useful than "Box 1". The script checks that the tracking code on the
fetched page matches the one in the config, so a mismatched URL fails loudly
rather than showing the wrong box.

## Running it locally

```bash
node scripts/fetch-tracking.mjs      # refresh docs/data/tracking.json
cd docs && python3 -m http.server 8899
```

Then open http://localhost:8899.

## When a lookup fails

A failed package keeps its card and is marked "Couldn't check", and a banner shows
the count. If *every* lookup fails, the script exits non-zero without writing, so a
network blip or an EasyPost page redesign can't overwrite good data with empty
data. In that case the workflow run goes red and the page keeps showing the last
good state.
