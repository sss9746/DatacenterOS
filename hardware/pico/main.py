# DataCenterOS fan sensor firmware (HW-2), MicroPython on Raspberry Pi Pico 2 W.
#
# Prints one JSON line per 100 ms window over USB serial:
#   {"seq": 12, "t_ms": 34567, "vsys_v": 6.168, "sound_rms": 0.012}
#
# vsys_v    : averaged VSYS reading (uncalibrated; only changes matter). When the
#             TT motor stalls it draws more current and VSYS sags ~0.07 V. This is
#             the stall signal. Measured: ~6.168 free-running, ~6.099 stopped.
# sound_rms : Big Sounds mic on GP26/ADC0, DC-removed RMS normalised 0..1. Kept
#             as a real reading, but it barely changes with the motor.
#
# Wiring: mic VCC->36 (3V3), G->33 (GND), AO->31 (GP26). Motor red->40 (VBUS),
# black->38 (GND), 100 uF across the motor. Nothing above 3.3 V touches a GPIO.
import sys
import time

from machine import ADC, Pin

WINDOW_MS = 100
MIC_SAMPLES = 200          # ~2 kHz over the 100 ms window
VSYS_READS_PER_SAMPLE = 5  # 1000 VSYS reads per window -> stable average
VSYS_SCALE = 3 * 3.3 / 65535

# Pico W boards share GP29 with the wireless chip; GP25 high deselects it so
# ADC3 reads VSYS/3. WiFi is never used by this firmware.
Pin(25, Pin.OUT, value=1)
Pin(29, Pin.IN)
vsys_adc = ADC(3)
mic_adc = ADC(26)

period_us = WINDOW_MS * 1000 // MIC_SAMPLES


def read_window():
    mic = [0] * MIC_SAMPLES
    vsys_sum = 0
    next_t = time.ticks_us()
    for i in range(MIC_SAMPLES):
        mic[i] = mic_adc.read_u16()
        for _ in range(VSYS_READS_PER_SAMPLE):
            vsys_sum += vsys_adc.read_u16()
        next_t = time.ticks_add(next_t, period_us)
        wait = time.ticks_diff(next_t, time.ticks_us())
        if wait > 0:
            time.sleep_us(wait)
    mean = sum(mic) / MIC_SAMPLES
    rms = (sum((v - mean) ** 2 for v in mic) / MIC_SAMPLES) ** 0.5
    vsys = vsys_sum / (MIC_SAMPLES * VSYS_READS_PER_SAMPLE) * VSYS_SCALE
    return vsys, min(rms / 32768, 1.0)


def main():
    seq = 0
    while True:
        vsys, sound = read_window()
        sys.stdout.write(
            '{"seq":%d,"t_ms":%d,"vsys_v":%.4f,"sound_rms":%.4f}\n'
            % (seq, time.ticks_ms(), vsys, sound)
        )
        seq += 1


try:
    main()
except KeyboardInterrupt:
    pass
