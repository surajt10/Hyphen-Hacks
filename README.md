# NorthStar

Safer routes for every way you move: walking, wheelchair, bike, e-scooter, moped / scooty and car.
NorthStar scores every block of San Francisco for *your* travel mode and time of day, routes around
the riskiest blocks, and tells you why. Phones can listen for gunshot-like bangs during a route and
reroute everyone nearby within seconds.

## Run it

Node is installed in `~/.local/node` (no admin rights needed).

```bash
export PATH=~/.local/node/bin:$PATH
cd "/Users/suraj/Documents/Hackathon - Hyphen Hacks/northstar"
node scripts/build-data.mjs      # refresh SF data (optional; data is already in public/data)
npx next build && npx next start -p 3002
```

Phones need an HTTPS link (for microphone and location). In a second terminal:

```bash
~/.local/bin/cloudflared tunnel --no-autoupdate --url http://localhost:3002
```

It prints a `https://….trycloudflare.com` link. Anyone with the link can open the app; the link
changes every time the tunnel restarts.

## Demo (about 3 minutes)

1. **Navigate tab** (looks like Google Maps). Search a place (e.g. *Ferry Building*). Directions open
   from **Your location** (or tap the map → *Start here*). Pick a travel mode at the top of the panel.
2. Route options: **Safer route** (blue, recommended, % less risk) vs **Fastest** (grey; tap it to switch).
   **Why this route** lists the real records behind each avoided spot; tap one to fly there.
3. Switch to **E-scooter** or **Car**: risk is re-weighted for the mode; car shows live Caltrans cameras.
4. **Best time to leave**: bars for now to +3 h; the blue bar is the lowest-risk time.
5. **How it works tab**: the scoring engine live. Click any spot on the map to see its score built
   event by event (weight × mode × age × hour), its citywide rank and the AVOID / PENALIZE / CLEAR decision.
   The event log shows every route request, avoid zone and live alert as it happens.
6. **Sound alert** (keep it short): ☰ menu → *Listen for gunshots* on two phones and play a clip (tell the
   organisers first), or ☰ → *Simulate a bang*. Answer **Danger**; routes nearby bend around it.
7. ☰ menu: light / dark mode (also the moon / sun button), language, large text, high contrast, safe places.

To clear live alerts between runs: `curl -X POST localhost:3002/api/live -H 'Content-Type: application/json' -d '{"action":"reset"}'`

## How it works

| Part | Where | Notes |
| --- | --- | --- |
| Risk model | `lib/scoring.ts` | H3 hexagons; event weight × travel-mode multiplier × age decay × time of day; route risk = Σ cell risk × minutes in cell |
| Data | `scripts/build-data.mjs` | SF police dispatch calls (violent types only; homeless, sit/lie and domestic calls excluded) + DataSF injury crashes |
| Routing | `app/api/route/route.ts` | Public Valhalla server (OpenStreetMap); one costing model per mode; risky cells sent as avoid polygons |
| Live alerts | `app/api/live/route.ts` | Sound detections + community reports; 2 phones in 3 s / 500 m = confirmed; reports count after 3 people agree |
| Sound | `lib/sound.ts` | On-device: loudness spike → Google's YAMNet classifier (TensorFlow.js); gunfire must beat fireworks. Audio is never recorded or uploaded |
| Roads | `app/api/roads/route.ts` | Caltrans cameras + lane closures (car and moped only) |
| Offline | `public/sw.js` | Caches the app, risk data and map tiles you've seen (production build only) |

## Advanced features (How it works tab)

- **Incident constellations:** violent incidents within 500 ft and 12 h of each other are linked into chains (gold lines). Click one to fly to it.
- **Next-hour forecast:** the same risk model run one hour ahead; orange hexagons are blocks getting riskier.
- **Live anomaly watch:** violent dispatch calls in the last 3 h per area vs that area's normal rate; 3x normal is flagged.
- **Acoustic sensor grid:** phones with "Listen for gunshots" on check in every 20 s; only area-level counts are kept.
- **Alert corroboration:** a phone-detected bang is matched against SFPD "shots fired" calls within 0.4 mi and 20 min, and the nearest public road camera is shown.
- All of this works on events and places, never on people (no faces, plates, identities or individual tracks).

## Live traffic (optional)

Car and moped ETAs use a typical SF traffic model by hour. For real-time traffic, create a free key at developer.tomtom.com, copy `.env.local.example` to `.env.local`, paste the key after `TOMTOM_API_KEY=`, and restart the server.

## Honest notes for judges

- Data is **recent, not live**: SF's public feed has ~300 dispatch calls a month with locations,
  and SF's incident-report feed no longer publishes locations at all.
- Safe havens come from OpenStreetMap and are off by default.
- Reason cards are generated from the records with built-in rules; no external AI service is called.
