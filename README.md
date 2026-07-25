# unitapp

A Web Bluetooth app for the **UNI-T UT320i** wireless pipe-clamp thermometer,
aimed at simple HVAC work (superheat/subcooling, delta-T across coils).

## Status

**The protocol is decoded and live readings work** — the app shows the
temperature in °C/°F with a trend chart, min/avg/max stats, and CSV export.

### Wire protocol

Confirmed on two units (SN:251101079, SN:260500277). Framing on the FF02
notify characteristic:

```
AA BB <len u8> <cmd u8> <payload…> <checksum u16 BE>
```

- `len` counts every byte after the len field (cmd + payload + checksum)
- `checksum` = additive sum of all bytes from the `AA` header through the end
  of payload, stored big-endian
- `cmd 0x01` (len `0x14`): live measurement — 8 reserved bytes, **float32 LE
  temperature in °C**, 4 reserved bytes, 1 status byte (`0xF3` observed)
- `cmd 0x08`, `cmd 0x06`: status/info responses right after the handshake
- The clamp streams nothing until something is written to FF01; the UT171
  START command (`ab cd 04 00 0a 01 16 00`) wakes it, after which `cmd 0x01`
  frames arrive roughly every 1.3 s

### GATT layout

| Service | Characteristic | Role |
|---|---|---|
| `0xFF12` (vendor, Realtek) | `FF01` write-no-response | command channel |
| | `FF02` notify | data channel — **silent until commanded** |
| | `FF03`–`FF0B` read/write | config registers (`FF05` = user id, `FF06` = device name) |
| `0x180A` | standard | device information |
| `d0ff…` | standard | Realtek OTA update service |

The `AA BB` dialect is a close cousin of the `AB CD` framing used by related
UNI-T "Smart Measure" meters (UT171, UT219P — see the
[ble-multimeter protocol docs](https://github.com/ble-multimeter/multimeter/tree/main/docs/protocols)),
whose START commands the clamp happily accepts as a wake-up.

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

## Open questions

- The 8 reserved bytes before and 4 after the temperature in `cmd 0x01`
  frames are always zero so far — possibly slots for min/max or multi-probe
  modes.
- The trailing status byte (`0xF3`) is unmapped — battery level and alarm
  flags presumably live there or in the `cmd 0x08`/`0x06` responses.
- The proper `AA BB`-dialect request commands are unknown; the app wakes the
  stream with the UT171 START frame, which works fine.

## Roadmap

- [x] Decode the measurement frame (temperature)
- [x] Trend chart + session logging (CSV)
- [ ] Map battery/status fields
- [ ] Multi-clamp support (the UT320i officially supports 6 concurrent clamps → delta-T)
- [ ] Superheat/subcooling calculator (pair with pressure readings entered manually)
