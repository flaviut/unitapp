# unitapp

A Web Bluetooth app for the **UNI-T UT320i** wireless pipe-clamp thermometer,
aimed at simple HVAC work (superheat/subcooling, delta-T across coils).

## Status

The UT320i's BLE protocol is **not publicly documented**, so the app currently
ships as a **protocol explorer**: it connects to the clamp, lists every GATT
service/characteristic it can see, subscribes to all notify characteristics,
and hex-dumps each frame. For every frame it also prints candidate int16
little-endian interpretations (scaled /10 and /100) in the plausible −50…150 °C
range — warm the clamp in your hand and watch which candidate tracks the
reading on the meter's own display. Once the format is known, implement
`decodeFrame()` in `app.js` and the live-reading panel comes alive.

## Running it

Web Bluetooth requires a **secure context** (HTTPS or `localhost`) and a
Chromium-based browser:

- ✅ Chrome / Edge on Windows, macOS, Android, ChromeOS
- ⚠️ Chrome on Linux: enable `chrome://flags/#enable-web-bluetooth` (BlueZ ≥ 5.41)
- ❌ Firefox, Safari (macOS and iOS) — no Web Bluetooth
- ⚠️ iPhone/iPad: only via third-party wrappers such as the
  [Bluefy](https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055) browser

Locally:

```sh
npx serve .        # or: python3 -m http.server
# open http://localhost:3000 (localhost counts as a secure context)
```

Or host it on GitHub Pages — the app is static files with no build step.

## Reverse-engineering workflow

1. Open the app in Chrome, click **Connect device**, pick the UT320i.
2. If no services appear, the clamp uses a service UUID not in
   `CANDIDATE_SERVICES` (`app.js`). Find the real UUIDs with
   [nRF Connect for Mobile](https://play.google.com/store/apps/details?id=no.nordicsemi.android.mcp)
   and add them to the list (Web Bluetooth can only touch services it declared
   up front).
3. If the clamp is silent until UNI-T's *Smart Measure* app talks to it, sniff
   the handshake (Android: developer-options **Bluetooth HCI snoop log**, view
   in Wireshark) and replay it with the **Write command** box.
4. Export captured frames to CSV, work out the framing, implement
   `decodeFrame()`.

Prior art worth reading — other UNI-T BLE meters have been reverse-engineered
and one project already does browser-based UNI-T logging over Web Bluetooth:

- <https://github.com/topics/uni-t>
- <https://github.com/ble-multimeter/multimeter>

## Roadmap

- [ ] Decode the measurement frame (temperature, battery, units)
- [ ] Multi-clamp support (the UT320i officially supports 6 concurrent clamps → delta-T)
- [ ] Trend chart + session logging
- [ ] Superheat/subcooling calculator (pair with pressure readings entered manually)
