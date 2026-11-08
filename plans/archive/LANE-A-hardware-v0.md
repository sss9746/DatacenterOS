# LANE A: Hardware, fan ML and QA (the team)

> **Ownership rule: Lane A has no single owner; the 4-person team does hardware together.** Whoever is free or blocked **claims the next A task in `plans/status/A.md` (write your name + time next to the ID) before starting it**, and un-claims it if they stop. Tasks are picked up by whoever is awake; there is no Lane-A sleep slot. Below, "you" means whoever holds the task.
> **SpacetimeDB work (publishing, tokens such as `STDB_BRIDGE_TOKEN`, allow-list, bindings) belongs to Lane B.** Physics, contracts, root files and merges stay with Lane S.
>
> **Read `plans/CONTRACTS.md` first. It wins over this file and over PLAN.md.** Per CONTRACTS §0, Lane A **no longer owns physics** (that moved to Lane S). Old PLAN rows `P1-A-01..03`, `P2-A-01`, `P3-A-01`, `P3-A-02` are **not yours**.
> Written Sat Nov 7, 4:45 PM. Submission Sun 12:00 PM. **Feature freeze Sun 10:00 AM.**

---

## 1. Your role in one screen

**Lane A owns the only real thing in the demo:** a real rack fan (TT motor + cardboard blade), a real vibration sensor (MPU-6050 on an ESP32-S3), a real trained anomaly model (runs on the laptop in Python), and the bridge that drives `rack_3` in the twin. Lane A is also the **QA owner of the demo path** (`scripts/demo_check.py`, `qa/`). During judging, **one teammate is the fan operator** (named at the 9:45 AM sync; they rehearse the fan beat).

| Lane A owns (only A tasks edit these) | Never touch from an A task (open `REQUEST <lane>: …` issue instead) |
|---|---|
| `hardware/**` (firmware, bridge, models, recordings, results) | `packages/physics/**`, `eval/**`, `scripts/sync-physics.mjs` (S); `spacetime/module/**`, `scripts/gen-bindings.sh`, tokens/allow-list (B) |
| `scripts/demo_check.py` | `plans/CONTRACTS.md`, root files: `package.json`, `pnpm-workspace.yaml`, `.env.example`, `.gitignore`, `README.md`, `CODEOWNERS` (S) |
| `qa/**` | `agents/**` (C). You **import** `agents/dcos_agents/stdb.py`; you never copy or edit it |
| `plans/status/A.md` | `apps/web/**`, `docs/**` (D); other people's `plans/status/*.md` |

Branch: `lane/a-hardware`. Commits: `feat(a): …` / `fix(a): …`. S merges your branch to `main` at syncs (order S → C → A → D).

### 1.1 Sync schedule (what you bring to each)
| Time | You bring | Pass condition |
|---|---|---|
| **7:00 PM** | IMU streaming ~200 lines/s, rig spinning, `hardware/bridge` project scaffolded | `record.py --print` shows 195–205 Hz; contract v1 frozen; you pull `main` |
| **9:00 PM** | 30 labeled recordings + `fan_bridge.py` v1 (RMS) sending to `dcos-dev`; replay works; **backup recordings committed** | coin/pen/tape → rack_3 `fan_anomaly ≥ 0.5` within 3 s on the dashboard |
| **11:00 PM** | `demo_check.py` checks 1–4 + fan item of the MVP checklist | `demo_check.py` exit 0 on `dcos-dev`; `git tag mvp` |
| **1:30 AM** | Autoencoder live in the bridge, 30-min healthy run started/finished, 3-line status | false alarms counted; status written; open A tasks clearly marked unclaimed for whoever is awake |
| **7:30 AM** | 20 lead-time runs + `fan_leadtime.csv` handed to S, mic fallback validated, demo_check full | CSV in S's hands; demo_check exit 0 on prod `dcos` |
| **9:45 AM** | Final demo_check run on prod + fan check (`qa/fan_check.md`) | both green before the **10:00 AM freeze** |

No Lane-A sleep slot: A tasks are picked up by whoever is awake (claim in `plans/status/A.md`). If nobody is on an A task overnight, leave a healthy replay loop running against `dcos-dev` so B/C don't get `fan_offline` incidents while they test (see A-P2-06).

---

## 2. Hardware pickup (hardware desk, ~4:50 PM, 15 min)

Requested: 1× ESP32-S3-DevKitC-1, 1× GY-521 (MPU-6050), 1× TT gear motor + wheel (wires attached), 1× 100 µF electrolytic cap, 6× F-F jumpers, 1× USB-C↔USB-C cable, 1× "Big Sounds" module (backup), hot glue gun. **Team brings:** cardboard, a coin, tape, a pen.

Inspect **before you walk away** (there is no soldering kit):
- [ ] **ESP32-S3-DevKitC-1:** silkscreen says DevKitC-1; **two USB-C ports** (labeled `USB` and `UART`/`COM`); both pin headers soldered, no bent pins; `RST` and `BOOT` buttons present.
- [ ] **GY-521:** 8 pins (VCC GND SCL SDA XDA XCL AD0 INT). **Header pins soldered:** each of the 8 pins has a shiny cone of solder on the board. If the header is loose in a bag → ask for a pre-soldered one **now**. If none exists, take it anyway and go to backup tier (a) at 6:30 PM.
- [ ] **TT motor:** both wires attached, insulation not torn; wheel's D-shaped hole fits the shaft. Note the wire ends: bare strands, male pins, or female Dupont (affects step B4).
- [ ] **Capacitor:** 100 µF, voltage rating printed **≥ 6.3 V** (10–25 V ideal), not bulging. Stripe side = **negative (−)**, **long leg = positive (+)**.
- [ ] **6× F-F jumpers:** all 6 present. **Ask for 4 extras + 2 M-F jumpers + a mini breadboard** if they have them (nice-to-have, not required). All 6 are used by the build below; Big Sounds needs 3 (it reuses the IMU's).
- [ ] **USB-C↔USB-C cable:** must be **data-capable** (charge-only cables are the #1 "board not detected" cause). Check the demo laptop has a USB-C port; if it only has USB-A, ask for USB-A↔USB-C.
- [ ] **Big Sounds module:** has an `AO` pin and the pins are soldered.
- [ ] **Hot glue gun** + at least 3 sticks.

---

## 3. Physical build (beginner-proof, with checkpoints)

### 3.1 Wiring diagram (pins configurable in the sketch; **trust the silkscreen labels on your board over this list**)
```
 ESP32-S3-DevKitC-1  (USB ports at the bottom; left header J1)
 J1: 3V3 3V3 RST 4 5 6 7 15 16 17 18 [8] 3 46 [9] 10 11 12 13 14 [5V] [G]
 J3 (right): [G] TX RX [1] 2 42 41 40 39 38 37 36 35 0 45 48 47 21 20 19 G G

   GY-521 (MPU-6050)                         ESP32-S3
   ┌─────────┐
   │ VCC  ●──┼──── jumper 1 ────────────────  3V3
   │ GND  ●──┼──── jumper 2 ────────────────  G   (J3, top)
   │ SCL  ●──┼──── jumper 3 ────────────────  GPIO9
   │ SDA  ●──┼──── jumper 4 ────────────────  GPIO8
   │ XDA XCL AD0 INT : leave unconnected (AD0 floating = address 0x68)
   └─────────┘

   TT motor                                  ESP32-S3
   red  ─┬─[cap + long leg twisted on]─ jumper 5 ─  5V   ← this jumper is the fan's "power switch"
         │        ┌───────┐
         │        │ 100µF │   (cap sits at the motor end; stripe = −)
         │        └───────┘
   black ┴─[cap − stripe leg twisted on]─ jumper 6 ─  G   (J1, bottom)

   Later (backup tier a): Big Sounds  VCC→3V3, GND→G, AO→GPIO1   (NEVER VCC→5V: AO would exceed 3.3 V)
```
Motor polarity does not matter (it only flips spin direction). **Capacitor polarity does matter.**

### 3.2 Steps
| # | Step | Checkpoint (do not continue until true) |
|---|---|---|
| B1 | Plug the ESP32 alone into the laptop via the port labeled **`USB`**. | Device Manager → Ports shows a new COM port (`USB Serial Device` / `USB JTAG/serial debug unit`). Write the COMx down. Red power LED on. |
| B2 | Unplug USB. Wire GY-521 with jumpers 1–4 exactly as §3.1. | Every jumper fully seated; wiggle test does not move them. |
| B3 | Plug in USB. | GY-521's small LED lights. If not: VCC/GND swapped or not seated. |
| B4 | Prepare motor leads. Bare strands: strip to ~1 cm, twist tight, fold back on itself so it is thick. Twist the cap's **long leg onto the red** lead and the **stripe leg onto the black** lead. Push each twisted bundle into a female end of jumpers 5 and 6. Wrap with tape, then a blob of hot glue as strain relief. (Male pins: same idea, twist the cap leg around the pin before pushing on.) | Tug test: a gentle pull does not separate anything. Cap legs cannot touch each other. |
| B5 | Rig body: double-layer cardboard base ~20 × 15 cm. Hot-glue the motor body flat on the base, shaft horizontal, overhanging the edge by 1 cm. | Motor does not rock when pushed. |
| B6 | Blade: cut a 2-blade propeller ~9 cm tip-to-tip from stiff cardboard; hot-glue it to the outer face of the wheel (tire can stay). Let it cool 2 min. | Blade spun by hand clears the table and the base by ≥ 1 cm. |
| B7 | Blade guard: a cardboard U-frame around the blade, 1–1.5 cm clearance, glued to the base. This is where the **tape flap** and **pen touch** faults happen. | Blade spun by hand never touches the guard. |
| B8 | IMU mount: hot-glue the GY-521 **back side** flat on the base, **3 cm from the motor**, chip side up. Note the axis arrows printed on it. Do **not** glue the ESP32: tape it down on a cardboard tray so `RST`/`BOOT`/USB stay reachable. | IMU is rigid (no wobble). |
| B9 | **First spin (blade OFF first):** pull the wheel off, connect jumper 5 → 5V and 6 → G. Motor runs. Then disconnect jumper 5, refit wheel+blade, reconnect. | Motor spins with the blade; the COM port does **not** disappear; no reboot banner in Serial Monitor. |
| B10 | 5-minute soak + 10 stop/start cycles (pull/replace jumper 5). | No ESP32 resets in 5 min; ≤ 1 reset in 10 cycles. Else → §3.6. |
| B11 | Label: "REAL FAN · RACK 3" on the base; tape the USB cable to the table (strain relief). | — |

**Safety rule: never stall the blade by hand** (stall current spikes → ESP32 brown-out, USB port overcurrent). Faults are only: taped coin, tape flap, light pen touch at the guard. To stop the fan, pull jumper 5 off the 5V pin.

### 3.3 Arduino IDE setup (start the downloads at the desk)
1. Install **Arduino IDE 2.3.x**. File → Preferences → *Additional boards manager URLs*: `https://espressif.github.io/arduino-esp32/package_esp32_index.json`.
2. Boards Manager → **"esp32" by Espressif Systems**, version **3.x** → Install (~300 MB, start early).
3. Library Manager → **"Adafruit MPU6050"** → Install, accept "install all" (pulls **Adafruit Unified Sensor** and **Adafruit BusIO**).
4. Tools menu: Board **"ESP32S3 Dev Module"**; **USB CDC On Boot: Enabled**; USB Mode: Hardware CDC and JTAG; Upload Mode: UART0 / Hardware CDC; Port: your COMx. Leave flash/PSRAM defaults.
5. **Use the port labeled `USB`** (native USB). With CDC On Boot enabled, `Serial` goes to that port and runs at full USB speed (the 921600 baud setting is accepted and harmless). Fallback: port `UART` with CDC On Boot **Disabled**; then 921600 baud is real (10 KB/s needed, fine).
6. Upload fails ("no serial data", port vanishes): hold **BOOT**, tap **RST**, release BOOT, upload, then tap RST. Close **Serial Monitor before running any Python** (only one program can open the COM port).

### 3.4 Sketch spec: `hardware/esp32_imu_stream/esp32_imu_stream.ino`
- `#define SDA_PIN 8`, `#define SCL_PIN 9`, `#define SAMPLE_HZ 200`, `#define BAUD 921600`, `#define FW_VERSION "dcos-imu-1"`.
- `setup()`: `Serial.begin(BAUD)`; wait ≤ 2 s for host; `Wire.begin(SDA_PIN, SCL_PIN)`; `Wire.setClock(400000)`; `mpu.begin(0x68, &Wire)` then try `0x69`. On failure print `# ERR no MPU6050 at 0x68/0x69 (check wiring)` once per second forever (bridge ignores `#` lines). On success: `setAccelerometerRange(MPU6050_RANGE_4_G)`, `setGyroRange(MPU6050_RANGE_500_DEG)`, `setFilterBandwidth(MPU6050_BAND_94_HZ)` (anti-alias below the 100 Hz Nyquist), print `# dcos-imu-1 hz=200 accel=4g gyro=500dps sda=8 scl=9`.
- `loop()`: fixed-rate scheduler on `micros()`: `next += 5000`; if more than 50 ms behind, resync and print `# WARN resync`. Read `mpu.getEvent(&a,&g,&t)`; convert accel m/s² → g (÷ 9.80665) and gyro rad/s → deg/s (× 57.29578).
- Output per CONTRACTS §7, one line per sample: `t_ms,ax,ay,az,gx,gy,gz\n` with `t_ms = millis()`, accel 4 decimals, gyro 2 decimals (`snprintf` into a 64-byte buffer, one `Serial.write`). ~50 B × 200/s = 10 KB/s.
- Comment lines start with `#` and are internal to Lane A (both ends are ours). No Wi-Fi, no `delay()` in the loop.
- Also write `hardware/esp32_i2c_scan/esp32_i2c_scan.ino` (prints every responding address on SDA 8 / SCL 9 every 2 s). Expected: `0x68`.

### 3.5 Troubleshooting
| Symptom | Fix, in order |
|---|---|
| No COM port at all | Other cable (charge-only!), other laptop port, the other USB-C port on the board, BOOT+RST dance |
| `# ERR no MPU6050` | Flash the I2C scanner. Nothing found → GY-521 LED on? SDA/SCL swapped? jumpers seated on the right header pins (count from the label)? Try pins 4/5 (change `#define`s). Header unsoldered/cracked → **tier (a)** at 6:30 PM |
| Scanner finds `0x69` | AD0 is high; the sketch's fallback handles it |
| ESP32 **resets when the motor starts** (port drops, boot banner) | Cap present & polarity right? Start with blade off; laptop port directly (no hub/dock); smaller blade; plug the laptop into its charger (some ports sag on battery); last resort: disable the brown-out detector in firmware (`WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0)` in `setup()`), demo-only |
| Rate < 190 lines/s | Serial Monitor still open; using `UART` port at a low baud; `delay()` in loop |
| Values look frozen / all zero | Loose SDA/SCL; reseat; check `getEvent` return |
| Spikes when someone bumps the table | Expected; put the rig on a folded cloth only if healthy data is re-recorded on it (never change the mounting after recording) |

---

## 4. Python bridge (`hardware/bridge/`)

Setup (whoever claims A-P0-02, by hand, before fan-out): `cd hardware/bridge; uv init --no-workspace --name dcos-fan; uv add pyserial numpy torch sounddevice httpx python-dotenv`. Env is read from the repo-root `.env.local` (`STDB_HOST`, `STDB_DB`, `STDB_BRIDGE_TOKEN`, `FAN_SERIAL_PORT`, `FAN_RACK_ID=rack_3`). Python 3.12. CPU torch is fine (the model has 890 parameters).

### 4.1 Module layout and owners
| File | Owner (sub-agent) | Purpose |
|---|---|---|
| `serial_io.py` | A-1 | `find_port() -> str \| None` (prefer USB VID `0x303A` Espressif, then `0x10C4` CP210x, `0x1A86` CH34x, else `FAN_SERIAL_PORT`); `open_port(port, baud=921600) -> serial.Serial` (timeout 1 s, DTR/RTS low); `parse_line(s) -> tuple[int, np.ndarray] \| None` (7 fields → `(t_ms, float32[6])`, `#` lines and malformed lines → None, counted); `iter_samples(ser)` generator; `parse_mic_line(s)` for `M,` lines (tier a) |
| `record.py` | A-1 | Labeled recordings + `--print` rate monitor |
| `features.py`, `detectors.py`, `sources.py`, `train_autoencoder.py`, `fan_bridge.py`, `stdb_min.py`, `tests/test_features.py` | A-2 | ML + bridge + replay |
| `eval_fan.py`, `leadtime/twin_leadtime.mjs` | A-3 (wave 2) | Metrics |

### 4.2 `record.py` (labeled recordings → `hardware/bridge/data/*.npz`)
- `uv run python record.py --print` → prints `rate=200.1 Hz gaps=0 bad_lines=0 last=…` once per second (P0 checkpoint).
- `uv run python record.py --label healthy --secs 60` (auto-numbered `healthy_01.npz`…). Labels → `fault_class`: `healthy`→healthy, `coin`→imbalance, `tapeflap`→obstruction, `pen`→obstruction, `healthy30min`→healthy (`--secs 1800`).
- **Fault runs are 60 s: 20 s healthy pre-roll, then the operator presses Enter at fault onset**, 40 s of fault. Coin runs: press `s`+Enter when pulling jumper 5 (stop), tape the coin, press Enter the instant jumper 5 goes back on (onset). Stopped intervals are excluded from training windows.
- File schema (`np.savez_compressed`): `imu` float32 (N,6) [ax,ay,az g; gx,gy,gz deg/s]; `t_ms` uint32 (N,); `fs`=200; `label`; `fault_class`; `events` str array of `"<t_ms>:<stop|onset|clear>"`; `source` (`imu` \| `esp32_mic` \| `laptop_mic`; mic files store `audio` float32 (N,) instead of `imu`); `meta_json` (time, fw version, port, rig notes). Appends a row to `data/manifest.csv`.
- Quality gate printed at the end: rate, % gaps (reject the file if > 1% of samples missing), mean accel RMS.
- **Recording plan (A-P1-01):** 10 healthy × 60 s, 10 coin, 5 tape-flap, 5 pen-touch = **30 files, ~40 min.** Do not move the rig between files.

### 4.3 `features.py`: the exact 18 features
Window = **200 samples (1 s)**, hop = **100 (0.5 s, 50% overlap)** → one feature vector per bridge report. At 200 Hz, a 200-point FFT has exactly **1 Hz bins**.

| Index | Name | Definition |
|---|---|---|
| 0–5 | `rms_ax, rms_ay, rms_az, rms_gx, rms_gy, rms_gz` | RMS of each axis after subtracting the window mean (removes gravity/bias). Accel in g, gyro in deg/s |
| 6–9 | `be_ax_1_5, be_ax_5_20, be_ax_20_50, be_ax_50_100` | log10(Σ\|X_k\|² + 1e-9) over bins in [1,5), [5,20), [20,50), [50,100] Hz of the Hann-windowed, mean-removed `ax` (DC bin excluded) |
| 10–13 | `be_ay_*` | same bands for `ay` |
| 14–17 | `be_az_*` | same bands for `az` |

PLAN's 0–20 Hz band is split into 1–5 (the blade's rotation fundamental: a TT motor at 5 V turns ~2.5–3.5 rev/s, which is where a coin imbalance shows up) and 5–20 (harmonics/flap clicks). The motor's own pre-gearbox hum (~150 Hz) is above Nyquist and is attenuated by the 94 Hz DLPF.

Also: `vibration_rms_g(w)` = RMS of the mean-removed accel magnitude √(ax²+ay²+az²) in g. **This is the `rms` sent to `report_fan_reading`.**
Audio variant (tiers a/b): `audio_features(w, fs)` = [RMS] + 17 log band energies on `np.geomspace(lo, hi, 18)` edges (ESP32 mic: fs 2000, 20–1000 Hz; laptop mic: fs 16000, 50–8000 Hz). Same 18-dim vector → same model code.
Test (`tests/test_features.py`, tricky pure logic only): a 3 Hz sine of amplitude A on `ax` → `rms_ax ≈ A/√2`, and `be_ax_1_5` is the largest `ax` band.

### 4.4 `detectors.py`
- **v1 `RmsDetector`** (MVP): calibrate on healthy windows (from recordings or `--calibrate 30` live seconds): μ, σ of `vibration_rms_g`. `thr = max(μ + 5σ, 1.3μ)`. `anomaly = 1 / (1 + exp(−(rms − thr) / max(σ, 1e-4)))` (exactly 0.5 at the threshold). Fault class: if anomaly < 0.5 → `healthy`; else if the 1–5 Hz band holds > 50% of accel band energy → `imbalance`, else `obstruction`. Saved to `models/rms_v1.json`.
- **`AeDetector`** (Phase 2, §4.5). Both expose `score(window) -> (anomaly: float, fault_class: str, rms: float)`.
- **Smoothing (both):** report the median of the last 3 window scores (≈ +0.5 s latency, kills single-window spikes). Alarm "event" for metrics = 2 consecutive reports ≥ 0.5; clear = 4 consecutive < 0.5.

### 4.5 `train_autoencoder.py`
- Data: healthy windows only. Train `healthy_01–08`, validate `healthy_09–10`. Standardize with healthy train μ/σ per feature (stored).
- Model: PyTorch MLP **18 → 16 → 8 → 16 → 18**, ReLU between layers, linear output. MSE, Adam lr 1e-3, batch 64, 300 epochs, `torch.manual_seed(0)`. Params: 304+136+144+306 = **890 (≈ 3.5 KB float32)**.
- Error `e` = mean squared reconstruction error of the standardized vector. **Threshold `thr` = 99th percentile of validation healthy errors.**
- **Anomaly = sigmoid(k · (e/thr − 1)), k = 6** → 0.5 at the threshold, ≈ 0.95 at 1.5× threshold.
- **Fault class = nearest centroid** (standardized feature space) over fault windows after onset: centroids `imbalance` (coin) and `obstruction` (tape flap + pen). If anomaly < 0.5 → `healthy`; if the nearest-centroid distance > 3× the median intra-class distance → `unknown`. Report leave-one-run-out class accuracy.
- Output `models/fan_ae.pt` = `torch.save({state_dict, mu, sd, thr, k, centroids, feature_names, source, n_params, trained_at, version})` + `models/fan_ae.json` (weights as lists, for the on-device stretch). `--source audio` trains the mic variant → `models/fan_ae_mic.pt`.
- Prints: train/val error, thr, per-file max anomaly (healthy files must stay < 0.5), detection latency per fault file, class accuracy, param count, file size, mean inference ms/window.
- Command: `uv run python train_autoencoder.py --data data --out models/fan_ae.pt`.

### 4.6 `fan_bridge.py`
```
uv run python fan_bridge.py                          # live IMU, auto port, AE if models/fan_ae.pt exists else RMS
uv run python fan_bridge.py --detector rms --calibrate 30
uv run python fan_bridge.py --dry-run                # compute + print, no reducer calls
uv run python fan_bridge.py --replay data/healthy_01.npz data/coin_03.npz [--loop]   # Enter = jump to next file
uv run python fan_bridge.py --source esp32-mic       # tier (a)
uv run python fan_bridge.py --source laptop-mic      # tier (b)
```
- **Threads:** a reader thread fills a ring buffer (`deque(maxlen=400)`); the main loop wakes every **0.5 s**, takes the last 200 samples, scores, and calls `call("report_fan_reading", FAN_RACK_ID, anomaly, fault_class, rms)` (CONTRACTS §4/§7). HTTP timeout 2 s; on error log it and **drop** the reading (never queue stale readings); one console line per report: `21:03:04 rack_3 a=0.07 healthy rms=0.012g src=imu sent=ok 38ms`.
- **Serial auto-reconnect:** on `SerialException`/no data for 2 s → close, print `REAL FAN OFFLINE – reconnecting`, retry `find_port()` every 2 s. **While disconnected, send nothing** (honest: the twin marks `fan_online=false` after `FAN_ONLINE_TIMEOUT_TICKS` and emits `fan_offline`). After reconnect, skip `#` lines and wait for 200 fresh samples before scoring.
- **SpacetimeDB access:** `sys.path.insert(0, <repo>/agents)`; `from dcos_agents import stdb`. The bridge must authenticate as the **bridge** identity (`report_fan_reading` allows bridge/admin only, not agent). Until C accepts the token request (§10, CR-1): set `os.environ["STDB_AGENT_TOKEN"] = os.environ["STDB_BRIDGE_TOKEN"]` **inside the bridge process before importing stdb** (separate process, no leak). If `agents/dcos_agents/stdb.py` is not merged yet, fall back to `stdb_min.py` with the **identical** signature `call(reducer: str, *args) -> None` (httpx `POST {STDB_HOST}/v1/database/{STDB_DB}/call/{reducer}`, JSON array body, `Authorization: Bearer {STDB_BRIDGE_TOKEN}`, raise on non-200). Delete the fallback import once stdb.py lands.
- **Replay mode (hardware backup, CONTRACTS §7):** `ReplaySource` feeds recorded samples at real-time pace (100 samples per 0.5 s) through the **same** features + live model, and sends `fault_class = "replay:" + cls` (e.g. `replay:imbalance`, `replay:healthy`) so the UI shows **REPLAY OF REAL RECORDING**. Multiple files play in order; Enter skips to the next (stage use: healthy → press Enter → fault).
- Logs every report to `results/bridge_log_<YYYYMMDD_HHMM>.csv` (`wall_time, src, anomaly, fault_class, rms, sent_ok, latency_ms`).

---

## 5. Metrics (all from real runs; reported honestly)

| Metric | Definition | How | Target |
|---|---|---|---|
| Detection latency | t(first alarm event) − t(onset mark), per fault run | `eval_fan.py` on the 20 fault files (model never trained on them; AE is healthy-only) | median ≤ 3 s |
| False alarms / hour | alarm events on `healthy30min_01.npz` × 2 | `eval_fan.py` | ≤ 1 /h (fallback trigger: > 2 in 10 min → keep RMS detector, PLAN §8) |
| Lead time vs twin temp warning | t(twin rack_3 `temp_c ≥ T_WARNING_C`) − t(detect) | `leadtime/twin_leadtime.mjs`: `compileTopology(defaultDemoConfig())`, `applyFailure` pump_fail pump_B (the demo's tight margin), 120 ticks to steady state, then each tick `setFanReading(s,'rack_3', anomaly_trace[t], tick)` + `step(s,1,makeRng(42))`; the fault segment is looped so the fault persists; stop at 600 ticks (`no_warning`) | report median; count `no_warning` |
| Model size / speed | params, `.pt` bytes, ms per window | printed by `train_autoencoder.py` | 890 params, < 1 ms |
| Class accuracy | leave-one-run-out nearest-centroid | `train_autoencoder.py` | report X/20 |

- **20 fault runs:** fresh, held-out runs recorded 4:30–5:30 AM with the final model (10 coin, 5 tape flap, 5 pen); the 30 earlier files are training/validation.
- Output: **`hardware/bridge/results/fan_leadtime.csv`** columns `run_id, fault_label, fault_class_pred, onset_s, detect_s, latency_s, twin_warn_s, lead_time_s, detector, model_version` + `results/fan_metrics.json` (medians, false alarms/h, n, params, size). `eval/` is Lane S's: **post the CSV path in team chat and hand it to S**, who copies it to `eval/results/fan_leadtime.csv`.
- `twin_leadtime.mjs` only **imports** `@dcos/physics` (`pnpm -F @dcos/physics build` first). If the import fails, do 3 runs live on `dcos-dev` (bridge + SQL poll of `telemetry_latest` rack_3) and say n=3.

---

## 6. Hardware backup plan (critical)

Same pipeline in every tier: 1 s windows → 18 features → healthy-trained AE → `report_fan_reading`. Pre-type each command in its own terminal tab so a switch takes < 30 s.

| Tier | Trigger | Decision deadline | What you do | Say on stage |
|---|---|---|---|---|
| **(a) GY-521 unusable** | Scanner finds nothing after rewiring; header unsoldered | **6:30 PM** (ask the desk for another GY-521 first) | Big Sounds: VCC→**3V3**, GND→G, AO→**GPIO1** (reuse jumpers 1, 2, 4). Flash `hardware/esp32_mic_stream/esp32_mic_stream.ino` (analogRead GPIO1 at **2000 Hz**, 11 dB attenuation, lines `M,<t_ms>,<v0>,…,<v19>` = 20 samples/line, 100 lines/s). Turn the module's pot until its DO LED is just off at fan noise. Record with `record.py --source esp32-mic`, train `--source audio`, run `fan_bridge.py --source esp32-mic` | "It's a real microphone on the ESP32 listening to the fan. Our vibration sensor died tonight, so we retrained the same autoencoder on sound." |
| **(b) ESP32 unusable** | No COM port / no data after cable + port + board swap | **7:00 PM**, and any time live | `fan_bridge.py --source laptop-mic` (`sounddevice`, 16 kHz mono, 1 s windows). Laptop mic 10–15 cm from the blade. **Venue noise:** record 2 × 60 s healthy + 2 faults **at the judging table** and retrain (< 1 min) before judging | "Our microcontroller died, so the laptop's microphone is the sensor: same features, same model, real fan, real faults." |
| **(c) Motor/fan unusable** | Motor dead, blade broken, rig resets uncontrollably | Backup recordings **committed by 9:00 PM**; switch any time in < 30 s | `fan_bridge.py --replay data/healthy_01.npz data/coin_03.npz` (UI shows REPLAY OF REAL RECORDING via the `replay:` prefix) | "This is a replay of a real recording from our rig; the screen says so. The model is scoring it live right now." |
| **(d) All hardware fails** | (a)–(c) all unavailable (e.g. no recordings) | **7:30 AM sync**, or live if (b)+(c) fail | Run the bridge with a synthetic, clearly labeled source **only after CR-3 is accepted** (`fault_class` prefix `sim:`); otherwise send nothing and let rack_3 show fan offline. Show the backup video of the real rig | "Our hardware failed, so this rack's fan is simulated and labeled as simulated. Here's the recorded video of the real rig and its measured numbers." |

**Record backups early (by 9:00 PM):** the 30 files from A-P1-01 are the replay backups. Because the root `.gitignore` ignores `data/`, **copy `healthy_01.npz`, `coin_03.npz`, `tapeflap_01.npz`, `pen_01.npz` to Google Drive + a USB stick** until CR-2 is accepted, then commit them.

**"Could" stretch: on-device inference (A-P3-03, only if every Must is done by 6:15 AM).** Level 1 (≈1 h): the ESP32 computes `vibration_rms_g` per 1 s window and the RMS-detector anomaly with thresholds compiled in from `models/rms_v1.json`, printing `# AD,<t_ms>,<anomaly>,<rms>` every 0.5 s; `fan_bridge.py --detector device` forwards those. Level 2 (≈2 h): port the 890-param AE from `models/fan_ae.json` as C arrays; band energies via a direct DFT (100 bins × 200 samples × 3 axes ≈ 60k MACs, trivial at 240 MHz, no FFT library). Report model size (KB) and on-device ms. The serial CSV stays unchanged; `#` lines carry the extra output.

---

## 7. QA duties

### 7.1 `scripts/demo_check.py` spec (A-3 writes it; you run it at every sync and after every deploy)
- `uv run --project agents python scripts/demo_check.py [--phase 1|2] [--fan skip|online|interactive] [--db dcos-dev] [--yes] [--no-reset] [--json]`.
- Imports `agents/dcos_agents/stdb.py` (`sql`, `call`, `proc`). Tokens: **`VITE_STDB_PRESENTER_TOKEN`** for seed/inject/request_action (exactly what the UI does), until CR-1 lands via the same env-swap trick; agent API at `VITE_AGENT_URL`.
- **It resets the database.** Refuses to run against `dcos` (prod) without `--yes`, and never during someone's rehearsal. Ends by calling `seed_demo_facility` again (unless `--no-reset`).
- Checks (PLAN §10), each with a timeout, PASS/FAIL + seconds:
  1. `call("seed_demo_facility")` → `SELECT * FROM component` has **12 rows**; `facility.tick` increases within 3 s.
  2. `inject_failure("pump_fail","pump_B","{}")` + `inject_failure("ticket_lie","pump_B","{}")` → `component` pump_B `status='offline'` within 3 s; `ticket` id 41 `status='completed'`.
  3. `request_action("shutdown_component","pump_A","{}","operator",0)` → newest `action` for pump_A (max id in Python; don't rely on `ORDER BY`) has `status='blocked'` and `safety_reason` starting `BLOCKED:` within 2 s.
  4. `POST /agent/ask {"question":"Can I shut down Pump A for maintenance?"}` (timeout 60 s, target 30) → `answer` contains `41` and `pump_B`/`pump b` (case-insensitive), `action_status=='blocked'`, and ≥ 4 `agent_step` rows with that `incident_id`.
  5. (`--phase 2`) `inject_failure("load_spike", …)` (params per CR-4) → within 90 s an incident with an `executed` action is `resolved`.
  6. (`--phase 2`) `inject_failure("sensor_freeze","rack_5","{}")` → within 60 s an incident's `hypothesis` contains `sensor`.
  7. Fan: `online` = `telemetry_latest` rack_3 `fan_online=true` and `fan_anomaly < 0.5`; `interactive` = prompts "apply pen touch now, press Enter" and asserts `fan_anomaly ≥ 0.5` within 3 s. Default `online`; the full manual check is `qa/fan_check.md`.
- Exit code = number of failed checks (0 = all green). `--json` writes the results to stdout for `qa/sync_log.md`.

### 7.2 `qa/` files
- `qa/fan_check.md` (manual, 3 min): rig intact & labeled → USB in, COM port visible → bridge live (`src=imu`) → healthy anomaly < 0.2 for 30 s → pen touch → ≥ 0.5 within 3 s, clears within 5 s → tape flap → `obstruction` → coin cycle (pull jumper 5, tape coin, reconnect) → `imbalance`, dashboard RealFanPanel moves, a `fan_vibration_anomaly` incident appears → remove faults → healthy → unplug USB → dashboard shows fan offline within ~5 s → replug → bridge reconnects within 5 s.
- `qa/demo_path.md`: the 7 PLAN §10 steps (reset → builder preset → fail pump B + ticket lie → "Can I shut down Pump A?" blocked → fan fault → 3 plans → execute → recovered → handoff note → results chart), with the expected screen at each step, who clicks, and the backup move if it fails.
- `qa/sync_log.md`: one row per sync: time, DB, `demo_check` exit code, failing checks, fan check result, owner pinged.
- `qa/judging.md`: pre-judging checklist (12:30 PM: rig spun 5 min, spare coin + tape tabs, 3 terminals pre-typed: live / replay / laptop-mic, hotspot, laptop on charger, sleep disabled).

### 7.3 Rehearsal and judging role (the fan operator runs the fan)
- **Stage fault, primary: the tape flap.** The judge sticks a pre-cut 3 cm tape flap onto the guard so the blade flicks it. Instant, loud, safe, the fan never stops. **Coin (imbalance) is the secondary** when a judge asks: pull jumper 5, judge presses a pre-made coin-on-tape tab onto a blade tip, reconnect (≈ 8 s; the stop itself honestly reads as an anomaly). Tell D so the pitch line says "sticks a tape flap / tapes a coin".
- Your lines (beat 1:25–2:05): "That's a real fan with a real accelerometer. The model learned what healthy sounds like. Go ahead, stick this on." → point at the anomaly gauge → "detected in about N seconds, while rack 3 is still green."
- Reset between judges: remove flap/coin, wait for healthy (≈ 3 s), check the dashboard is green.
- If anything breaks live: Ctrl+C the bridge, run the pre-typed replay tab, use the tier line from §6.

---

## 8. Sub-agent prompts (ready to paste)

Worktrees (PowerShell, from the repo root, after A-P0-03 is committed on `lane/a-hardware`). Sub-branch names use a hyphen because git cannot hold both `lane/a-hardware` and `lane/a-hardware/x` (see CR-5):
```powershell
git switch lane/a-hardware
git worktree add ..\dcos-a1 -b lane/a-hardware-a1 lane/a-hardware
git worktree add ..\dcos-a2 -b lane/a-hardware-a2 lane/a-hardware
git worktree add ..\dcos-a3 -b lane/a-hardware-a3 lane/a-hardware
# open a terminal in each (cd ..\dcos-a1; claude) and paste the prompt
# merge back when done:
git switch lane/a-hardware; git merge --no-ff lane/a-hardware-a1; git worktree remove ..\dcos-a1
```

**A-1: firmware + serial + record.py (start ~5:05 PM, done by 6:00 PM)**
```
Goal: ESP32-S3 streams MPU-6050 data at 200 Hz over USB serial and record.py saves labeled recordings (demo step: "the real fan drives rack_3").
Read first: plans/CONTRACTS.md §7 and plans/LANE-A-hardware.md §3.3–3.5, §4.1–4.2, §6 tier (a).
Owns (create/edit only these): hardware/esp32_imu_stream/esp32_imu_stream.ino, hardware/esp32_i2c_scan/esp32_i2c_scan.ino, hardware/esp32_mic_stream/esp32_mic_stream.ino, hardware/bridge/serial_io.py, hardware/bridge/record.py.
Must not: edit any other file, install packages (pyserial, numpy, sounddevice are already in hardware/bridge/pyproject.toml), change contracts, or commit.
Contract: serial line `t_ms,ax,ay,az,gx,gy,gz\n` (g, deg/s), 921600 baud, 200 lines/s; `#` lines are comments; mic sketch emits `M,<t_ms>,<20 samples>`. serial_io API exactly as LANE-A §4.1 (find_port, open_port, parse_line, iter_samples, parse_mic_line). npz schema exactly as LANE-A §4.2.
Done when: both sketches compile in Arduino IDE for "ESP32S3 Dev Module" (or arduino-cli: `arduino-cli compile --fqbn esp32:esp32:esp32s3 hardware/esp32_imu_stream`); `uv run python -c "import serial_io, record"` works in hardware/bridge; `parse_line` handles good, `#`, and malformed lines (tiny inline asserts, no test framework); `record.py --help` shows --print, --label, --secs, --source.
Report: files changed, how A verifies on hardware, open questions, any requested deps.
Hackathon mode: no tests beyond the parse_line asserts; working beats elegant.
```

**A-2: features + detectors + autoencoder + bridge + replay (start ~5:05 PM; v1 RMS bridge by 8:00 PM, AE code by 11:00 PM)**
```
Goal: fan_bridge.py turns the live 200 Hz IMU stream (or a replayed .npz, or a mic) into report_fan_reading calls every 0.5 s with an anomaly score from an RMS detector (v1) and a healthy-trained autoencoder (v2) (demo step: "coin/tape on the real fan → rack_3 anomaly ≥ 0.5 within 3 s").
Read first: plans/CONTRACTS.md §4 and §7, plans/LANE-A-hardware.md §4.3–4.6 and §6.
Owns: hardware/bridge/features.py, detectors.py, sources.py, train_autoencoder.py, fan_bridge.py, stdb_min.py, tests/test_features.py, models/.gitkeep.
Must not: edit serial_io.py or record.py (A-1 owns them; import serial_io per the API in LANE-A §4.1, stub it locally only if it is missing), edit anything under agents/ (import agents/dcos_agents/stdb.py; fall back to stdb_min.py with the identical `call(reducer, *args)` signature), install packages, change contracts, or commit.
Contract: exactly 18 features in the order of LANE-A §4.3; rms = mean-removed accel-magnitude RMS in g; anomaly 0..1 with 0.5 = fault; fault_class ∈ {healthy, imbalance, obstruction, unknown}; replay prefixes it with "replay:"; bridge authenticates with STDB_BRIDGE_TOKEN (env-swap trick in LANE-A §4.6); env from repo-root .env.local.
Done when: `uv run pytest tests/test_features.py` passes (3 Hz sine test); `uv run python fan_bridge.py --replay <synthetic npz you generate in a temp dir> --dry-run` prints a report line every 0.5 s with replay: prefix; `uv run python train_autoencoder.py --data <synthetic dir>` trains and writes a .pt with the fields in LANE-A §4.5; serial disconnect path is exercised by `--dry-run` with no device (prints REAL FAN OFFLINE and retries every 2 s without crashing).
Report: files changed, exact commands for A to run on real data, open questions, requested deps or contract changes.
Hackathon mode: only the features test; working beats elegant.
```

**A-3: demo_check.py + qa/ (wave 1, start ~5:05 PM, done by 8:30 PM) and metrics (wave 2, start ~11:15 PM)**
```
Goal: one command proves the demo path works end to end, plus manual QA checklists; later, the fan metrics (demo steps: all of PLAN §10).
Read first: plans/CONTRACTS.md §3–§5 and §7, PLAN.md §4.2 and §10, plans/LANE-A-hardware.md §5 and §7.
Owns (wave 1): scripts/demo_check.py, qa/fan_check.md, qa/demo_path.md, qa/sync_log.md, qa/judging.md. (Wave 2): hardware/bridge/eval_fan.py, hardware/bridge/leadtime/twin_leadtime.mjs.
Must not: edit anything else (import agents/dcos_agents/stdb.py; import @dcos/physics read-only), install packages, change contracts, or commit.
Contract: reducer names/arg orders exactly CONTRACTS §3.3; SQL column names exactly §3.1; agent API §5; checks exactly LANE-A §7.1; exit code = number of failed checks; refuse STDB_DB=dcos without --yes.
Done when (wave 1): `python scripts/demo_check.py --help` works; with STDB unreachable it prints FAIL for check 1 with a clear message and exits non-zero (no traceback); with a fake stdb module (monkeypatched inline, not committed) checks 1–4 pass. (Wave 2): eval_fan.py on a synthetic directory writes results/fan_leadtime.csv with the LANE-A §5 columns and results/fan_metrics.json; twin_leadtime.mjs runs against the built @dcos/physics, or prints a clear "physics not built" error.
Report: files changed, how to run at each sync, open questions (especially load_spike params), requested deps.
Hackathon mode: no test suite; the script is the test.
```

---

## 9. Task table

| ID | Clock | Dur | Task | Depends | Files | Command / action | Done when |
|---|---|---|---|---|---|---|---|
| **A-P0-01** | 4:45–5:00 | 15m | Pickup + inspection (§2); start IDE/core downloads on the laptop first | — | — | §2 checklist | All boxes ticked; GY-521 header verdict known |
| A-P0-02 | 5:00–5:10 | 10m | Lane branch + `hardware/bridge` uv project + `.env.local` keys you have | repo from D | `hardware/bridge/pyproject.toml`, `uv.lock` | `git switch -c lane/a-hardware`; `uv init …; uv add …` (§4) | `uv run python -c "import torch, serial, sounddevice"` OK; committed |
| A-P0-03 | 5:05 | 5m | Fan out A-1, A-2, A-3 (§8) | A-P0-02 | worktrees | `git worktree add …` | 3 agents running |
| A-P0-04 | 5:10–5:25 | 15m | Arduino IDE: esp32 core 3.x, Adafruit MPU6050, board settings (§3.3) | A-P0-01 | — | Boards/Library Manager | Blink-free "hello" sketch uploads to the `USB` port |
| A-P0-05 | 5:25–5:45 | 20m | Wire IMU (B1–B3), I2C scan | A-P0-04, A-1 scanner (or Arduino example *Wire → i2c_scanner*) | — | flash scanner | `0x68` found |
| A-P0-06 | 5:45–6:15 | 30m | Flash `esp32_imu_stream.ino`; verify stream | A-1 | — | `uv run python record.py --print` (or Serial Monitor first) | 195–205 lines/s, 0 gaps |
| A-P0-07 | 6:15–7:00 | 45m | Fan rig B4–B11 (motor, cap, blade, guard, IMU glue) | A-P0-06 | — | §3.2 | Spins 5 min, no resets |
| **A-P0-08** | **6:30** | — | **Decision: IMU OK? else tier (a)** | A-P0-05 | — | §6 | Decision posted in chat |
| A-P1-01 | 7:00–7:45 | 45m | 30 labeled recordings (§4.2) | A-P0-07, A-1 | `hardware/bridge/data/*.npz` | `record.py --label …` | 30 files pass quality gate; manifest.csv |
| A-P1-02 | 7:45–8:15 | 30m | Merge A-2 v1; offline check of RMS detector on recordings | A-2 v1 | — | `fan_bridge.py --replay data/coin_01.npz --dry-run` | Healthy files < 0.5; coin/pen/tape ≥ 0.5 within 3 s |
| A-P1-03 | 8:15–8:45 | 30m | Live bridge `--dry-run` with the rig; then live to `dcos-dev` | **STDB_BRIDGE_TOKEN + bridge allow-list from B (~9 PM)**, **stdb.py from C** (else `stdb_min.py`) | — | `fan_bridge.py --detector rms --calibrate 30` | rack_3 `fan_anomaly` changes in `SELECT * FROM telemetry_latest` |
| **A-P1-04** | 8:45–9:00 | 15m | **Backups:** copy 4 key files to Drive + USB; replay to `dcos-dev` shows `replay:` | A-P1-01 | — | `fan_bridge.py --replay …` | UI/SQL shows replay prefix; files off-laptop |
| A-P1-05 | 9:00 | — | **9:00 PM sync:** fan → rack_3 live | A-P1-03 | `plans/status/A.md` | PR `lane/a-hardware → main` | S merged |
| A-P1-06 | 9:00–9:45 | 45m | Merge A-3 wave 1; run `demo_check.py` on `dcos-dev` | A-3, S module, C api | `scripts/demo_check.py`, `qa/*` | `python scripts/demo_check.py --db dcos-dev` | Runs; failing checks reported to owners |
| A-P1-07 | 9:45–10:15 | 30m | `qa/fan_check.md` full pass; fix the rig | A-P1-03 | — | §7.2 | All fan items green |
| A-P1-08 | 10:15–11:00 | 45m | MVP checklist fan item + demo_check exit 0 | all P1 | `qa/sync_log.md` | demo_check | Exit 0; **11:00 PM sync, `git tag mvp`** |
| A-P2-01 | 11:15–12:00 | 45m | Train AE on real data, review printout | A-2 AE code | `models/fan_ae.pt`, `.json` | `train_autoencoder.py --data data` | Healthy val max < 0.5; fault latency ≤ 3 s |
| A-P2-02 | 12:00–12:30 | 30m | AE live in the bridge; fault class check | A-P2-01 | — | `fan_bridge.py` | Coin → imbalance, tape/pen → obstruction on dashboard |
| A-P2-03 | 12:30–1:00 | 30m | Start 30-min healthy recording (runs alone; don't touch the table) | A-P2-02 | `data/healthy30min_01.npz` | `record.py --label healthy30min --secs 1800` | File saved |
| A-P2-04 | 12:35–1:15 | 40m | Merge A-3 wave 2 (`eval_fan.py`, `twin_leadtime.mjs`), dry run on the 20 old fault files | A-3 w2, `@dcos/physics` built by S | `results/*` | `uv run python eval_fan.py` | CSV produced (provisional) |
| A-P2-05 | 1:15–1:30 | 15m | False alarms/h from the 30-min file; tune AE `k`/smoothing if > 1/h | A-P2-03 | `results/fan_metrics.json` | `eval_fan.py --false-alarms` | Number recorded |
| A-P2-06 | 1:30 | — | **1:30 AM sync** + status; start overnight `fan_bridge.py --replay data/healthy_01.npz --loop` on `dcos-dev`; laptop sleep off | — | `plans/status/A.md` | — | Status posted; unclaimed A tasks visible for whoever is awake |
| A-P3-01 | 4:30–5:30 | 60m | 20 fresh held-out fault runs (10 coin, 5 tape, 5 pen) | A-P2-02 | `data/lt_*.npz` | `record.py --label coin …` | 20 files |
| A-P3-02 | 5:30–5:50 | 20m | Final metrics → **hand `results/fan_leadtime.csv` to S** | A-P3-01 | `results/fan_leadtime.csv` | `eval_fan.py --runs data/lt_*` | Median latency, lead time, false alarms/h, model size posted in chat |
| A-P3-03 | 5:50–6:30 | 40m | Validate tier (b): laptop mic record 2 healthy + 2 faults, train `--source audio`, run | A-2 sources | `models/fan_ae_mic.pt` | `fan_bridge.py --source laptop-mic --dry-run` | Faults ≥ 0.5 by mic |
| A-P3-04 | 6:30–7:30 | 60m | **Could:** on-device inference L1 (§6), else help D with RealFanPanel visuals | all Musts | `esp32_imu_stream.ino` | — | `# AD,` lines forwarded |
| A-P3-05 | 7:30 | — | **7:30 AM sync:** demo_check on prod `dcos` | — | `qa/sync_log.md` | `demo_check.py --db dcos --yes --phase 2` | Exit 0 or owners pinged |
| A-P4-01 | 7:45–8:05 | 20m | Rig hardening (PLAN P4-A-01): re-glue, label, spare coin tabs + tape flaps, cable strain relief | — | — | — | Survives 10 fault cycles |
| A-P4-02 | 8:05–9:00 | 55m | Help rehearsals; record a phone clip of the rig for the video/GIF | — | — | — | Clip sent to D |
| A-P4-03 | 9:00–9:30 | 30m | Run the fan for D's backup video | D | — | — | Video has the live fan moment |
| A-P4-04 | 9:30–9:45 | 15m | Rehearse ×5 (your fan beat ≤ 40 s) | — | — | — | 3 clean in a row |
| **A-P4-05** | **9:45** | 15m | **Final demo_check + fan check on prod** | — | `qa/sync_log.md` | — | Both green → **10:00 AM freeze** |
| A-P5-01 | 10:00–12:00 | — | Only `fix(demo):` commits approved by Suvan; give D the fan numbers + 1 photo for Devpost | — | — | — | — |
| A-P5-02 | 12:30 PM | 20m | Pre-judging (`qa/judging.md`); **judging 1–4 PM: the fan operator runs the fan** | — | — | — | Rig spun 5 min, 3 terminals pre-typed |

### 9.1 Lane time estimate
| Block | Uncompressed | With agents | Hard milestone |
|---|---|---|---|
| Hardware build + bring-up (human only) | 2.5 h | 2.5 h | IMU streaming **7:00 PM** |
| Firmware + record.py | 1.5 h | 0.5 h review | — |
| Recordings (human only) | 1 h | 1 h | backups off-laptop **9:00 PM** |
| Features + RMS bridge + replay | 2.5 h | 0.75 h | rack_3 live **9:00 PM** |
| demo_check + qa | 2 h | 0.5 h | exit 0 **11:00 PM** |
| AE + metrics code | 3 h | 1 h | AE live **12:30 AM** |
| Lead-time runs + 30-min run (human) | 1.5 h | 1.5 h | CSV to S **5:50 AM** |
| Fallback validation + hardening + rehearsal | 2.5 h | 2.5 h | freeze **10:00 AM** |
| **Total** | **~16.5 h** | **~10.5 h** of team time, split across whoever is free (≈ 1 person continuously, more at build/recording time) | ~3.5 h slack for debugging |

---

## 10. Contract requests to file (issues `CONTRACT a: …` / `REQUEST <lane>: …`)
- **CR-1 (C, stdb.py):** add keyword-only `token: str | None = None` to `sql/call/proc` (additive), or read `STDB_TOKEN` if set. The bridge needs the **bridge** role and demo_check the **presenter** role; today stdb.py only knows the agent token. Interim: in-process env swap.
- **CR-2 (S, .gitignore):** add `!hardware/bridge/data/` and `!hardware/bridge/data/**` so replay recordings (~6 MB total, `savez_compressed`) are committed; CONTRACTS §7 points replay at that path.
- **CR-3 (S contract + D UI):** additive `fault_class` prefix `sim:` → UI shows "SIMULATED FAN (hardware unavailable)" for tier (d).
- **CR-4 (S contract, B module):** document `params_json` for `load_spike` (and confirm `{}` for `pump_fail`, `ticket_lie`, `sensor_freeze`) so demo_check checks 2, 5, 6 are exact.
- **CR-5 (S, §11):** `lane/s-core/physics`-style sub-branches cannot coexist with a `lane/s-core` branch in git (ref path conflict). Use `lane/<lane>-<task>` (e.g. `lane/a-hardware-a1`).
- **CR-6 (S, physics sanity):** with `PASSIVE_K_PER_S = 0.02` as a pull of 0.02·(T−22) K/s and 60 kJ/°C, a 6 kW rack with **zero** cooling settles at 22 + (6/60)/0.02 = **27 °C**, so `T_WARNING_C = 35` (and the "8 racks shut down in ~6 min" claim) is unreachable. Confirm the thermal model; the fan lead-time metric is undefined otherwise.
- **CR-7 (S, note in §7):** serial lines starting `#` are comments, and `M,` lines are the mic fallback format (Lane-A-internal, additive).

---

## 11. Status template: `plans/status/A.md`
```markdown
# Lane A status: <time>
## Claims (claim BEFORE starting; clear when you stop)
| Task ID | Claimed by | Since | State |
|---|---|---|---|
| A-P1-01 | <name> | 7:02 PM | in progress |
- Done: <ids>  (e.g. A-P0-06 IMU 200 Hz, A-P1-01 30 recordings)
- In progress: <id> — <what>, ETA <time>
- Blocked: <what> — waiting on <lane/person> (since <time>)
- Hardware tier in use: live IMU | (a) ESP32 mic | (b) laptop mic | (c) replay | (d) sim
- Fan numbers: latency median <s>, false alarms <n>/h, lead time median <s>, model <params>/<KB>
- demo_check: exit <n> on <db> at <time>; failing: <checks>
- Backups: recordings on Drive/USB <yes/no>, committed <yes/no>
- Needs from others: <token / stdb.py / contract request #>
```

## 12. PR checklist (`lane/a-hardware → main`, opened before each sync)
- [ ] `git fetch && git rebase origin/main` done; no files outside `hardware/**`, `scripts/demo_check.py`, `qa/**`, `plans/status/A.md`
- [ ] No secrets: `git diff origin/main | Select-String -Pattern "token|eyJ"` is clean; `.env.local` untracked
- [ ] Sketches compile; `uv run pytest hardware/bridge/tests` passes
- [ ] `fan_bridge.py --replay data/healthy_01.npz --dry-run` runs (if recordings are committed)
- [ ] `python scripts/demo_check.py --db dcos-dev` result pasted in the PR body and in `qa/sync_log.md`
- [ ] Models committed are the ones in use (`models/fan_ae.pt` version printed by the bridge matches)
- [ ] `plans/status/A.md` updated; contract requests filed as issues, not edits
- [ ] Commits are `feat(a): …` / `fix(a): …`
