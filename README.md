# unitapp

A Web Bluetooth app for the **UNI-T UT320i** wireless pipe-clamp thermometer,
aimed at simple HVAC work (superheat/subcooling, delta-T across coils).

## Status

**Working HVAC thermometer**, deliberately minimal — the main screen is just
connect, temperatures, ΔT, superheat/subcool, and a trend chart:

- Multiple clamps at once (the UT320i supports up to 6) with per-clamp cards
- Battery level on every clamp card, red when it's time to swap cells
- Live **ΔT** between the first two clamps — supply/return, in/out of a coil
- °F/°C toggle (remembered), 10-minute multi-line trend chart
- No babysitting: the screen stays awake automatically while a clamp is
  connected, and dropped clamps reconnect themselves
- **Superheat/subcool calculator**: enter gauge pressure, pick the clamp on
  the line — supports R-410A, R-32, R-454B, R-22, R-407C, R-404A, R-134a.
  Saturation tables generated with CoolProp 8.0 (NIST-grade equations of
  state), dew line for superheat and bubble line for subcool so glide blends
  are handled correctly
- Debug menu (collapsed by default) is a single "Copy diagnostics" button:
  clamp states, raw status bytes, and the last raw frames, ready to paste
  into a bug report

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
- `cmd 0x08` (len `0x05`): **battery**, payload `[scale, level]` — observed
  `04 04` on a clamp showing 3 display bars and `04 03` at 2 bars, so the
  display shows roughly `level − 1` bars of `scale`
- `cmd 0x06` (len `0x0B`): info/flags response right after the handshake —
  payload `01 00 01 00 00 01 00 00` identical on both units, unmapped
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
- Battery is **not** in the live frame (status byte `0xF3` and all reserved
  bytes identical across clamps at different levels) — it's in the
  `cmd 0x08` handshake payload, decoded above from a two-unit comparison.
  The `level − 1 ≈ display bars` mapping and the low end of the scale are
  extrapolated from levels 3 and 4 only; captures near empty would pin
  them down.
- The trailing live-frame status byte (`0xF3`) and the `cmd 0x06` payload
  are still unmapped — alarm flags presumably live in one of them.
- The proper `AA BB`-dialect request commands are unknown; the app wakes the
  stream with the UT171 START frame, which works fine.

## Roadmap

- [x] Decode the measurement frame (temperature)
- [x] Trend chart
- [x] Multi-clamp support with live delta-T
- [x] Superheat/subcooling calculator (CoolProp-generated PT tables)
- [x] Map the battery field (cmd 0x08 payload) — shown on each clamp card,
  red when low
- [ ] Map the live-frame status byte and cmd 0x06 flags (alarms?)
