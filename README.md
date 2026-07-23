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

## Email alerts

`scripts/notify.mjs` emails the family twice per box: once when it's about to
arrive, and again once it's delivered.

- **Arriving** fires when FedEx marks the box out for delivery, or when the
  estimated delivery date is today and it hasn't been delivered yet, whichever
  happens first.
- **Delivered** fires when FedEx marks it delivered, and includes who signed
  for it when FedEx reports a name.

`state/notified.json` records what has already gone out, so each box triggers
each email exactly once. State is written only after the send succeeds, so a
failed send retries on the next run rather than being silently swallowed.

Preview without sending anything:

```bash
npm run notify:dry
```

Recipients live in the `MAIL_TO` secret rather than in this file, because the
repo is public and addresses in a public repo get scraped.

### Turning it on

Three repository secrets are needed (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `MAIL_TO` | comma-separated recipients |
| `SMTP_USER` | the Gmail address the mail is sent from |
| `SMTP_PASS` | a Gmail **app password**, not the account password |

An app password comes from the Google account's security settings and requires
2-step verification. Set them from the terminal with `gh secret set MAIL_TO`
and so on, which prompts for the value instead of putting it in shell history.

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
