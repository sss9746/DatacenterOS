# Lane HW (shared, optional): Pico fan + real Brev GPU (Gate 5)

**Owner:** the whole team. Whoever is blocked or ahead claims the next task in `plans/status/HW.md` first.
**Branch:** `lane/hw`.
**Owns:** `hardware/**`.
**Rules:**
- **No software gate depends on this lane.** Work here only when your own lane isn't on the critical path, and full integration only after Gate 3.
- HW-1 and HW-2 (wiring, firmware, recording) can happen any time someone is waiting.

## Parts
- Raspberry Pi Pico 2 WH (all the ESP32s were taken)
- **Micro-USB data cable** (your USB-C cable won't fit the Pico)
- Big Sounds microphone module
- TT gear motor + wheel
- 100 µF capacitor
- F-F jumper wires
- tape

No soldering, breadboard or battery needed.

## Wiring (USB unplugged while wiring)
| From | To |
|---|---|
| Sound sensor `+`/VCC | Pico **pin 36, 3V3(OUT)** (**never** VBUS) |
| Sound sensor `G` | Pico **pin 33, GND** |
| Sound sensor `AO` | Pico **pin 31, GP26/ADC0** |
| Motor red | Pico **pin 40, VBUS** (5 V from USB) |
| Motor black | Pico **pin 38, GND** |
| Capacitor | On the motor terminals: long leg (+) to the VBUS side |

Tape the microphone against the motor body. Don't fully stall the wheel for more than ~2 s, or the USB power may cut out.

## Tasks
| ID | Task | Owns | Done when |
|---|---|---|---|
| **HW-1** | Wire it; flash MicroPython (hold BOOTSEL, plug in, drop the Pico 2 W `.uf2` from micropython.org onto the drive) | — | The motor spins; a COM port shows up in Device Manager |
| **HW-2** | Firmware `hardware/pico/main.py`: sample GP26 at about 2 kHz, compute RMS over 100 ms windows (normalized 0–1), and print one JSON line per window: `{"seq":n,"t_ms":…,"sound_rms":0.42}` | `hardware/pico/**` | The serial monitor streams lines, and pinching the wheel changes `sound_rms` |
| **HW-3** | **Record a backup:** 2 min (normal → pinch → recover) saved to `hardware/recordings/fan-backup.jsonl` (< 5 MB) | `hardware/recordings/**` | The file replays (HW-4 `--replay`) |
| **HW-4** | Gateway `hardware/gateway` (Node TS, `serialport`): 30 s calibration → baseline mean/std → `anomaly_score` from the z-score (clamped 0–1). For each window it builds a `HardwareSample` (`sensor_id: "pico-fan-r3"`, `sensor_kind: "microphone"`, `accel_rms_g: null`), checks it with `validatePayload`, maps it to `fan-sensor-r3`, and sends TelemetryEvents `fan.sound_rms` / `fan.anomaly_score` via `ingestObservations` (gateway token, ≤ 5 Hz). `--replay <file>` sends `source_kind: "replay"`, which the UI must show as **REPLAY OF REAL RECORDING** | `hardware/gateway/**` | Samples appear in `telemetry_recent`; duplicates are rejected; replay works |
| **HW-5** | **Demo mapping (explicit, opt-in):** `configure_run` with `fan_drives_loop_a=true` (P2-9) turns a sustained anomaly (> 0.7 for 3 s) into a visible `cooling_pump_degradation` fault on pump-a, labeled "demo rule: fan anomaly → loop-a cooling" | — (P2 implements; HW tests) | Pinch the fan → r2–r4 start heating → the agent responds |
| **HW-6** | **F-NV2: real GPU collector** `hardware/nvidia-smi-collector` (Node TS, runs on the Brev box). Every 1 s: `nvidia-smi --query-gpu=temperature.gpu,power.draw,utilization.gpu,clocks.sm --format=csv,noheader,nounits` → TelemetryEvents `nvidia_smi.*` for `gpu-real-0` (`source_kind: "hardware"`, `quality: "good"`, `labels.collector: "nvidia-smi"`) → `ingestObservations` | `hardware/nvidia-smi-collector/**` | The REAL GPU tile updates live. Optional: a short load (`python -c` torch matmul loop, ≤ 60 s) to heat it. **Don't starve the NIM:** test the load away from demo time |

## Claude sub-agent prompt
"Do HW-2 (MicroPython for Raspberry Pi Pico 2 W, Big Sounds AO on GP26, JSON lines over USB serial) and HW-4 (Node TS gateway using `serialport`, `@dcos/contracts` `validatePayload`, `@dcos/db-client` `ingestObservations`; `--replay` mode) per plans/LANE-HW-shared.md. Own only `hardware/**`."
