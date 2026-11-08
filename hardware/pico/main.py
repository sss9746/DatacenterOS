# DataCenterOS fan sensor firmware (HW-2), MicroPython on Raspberry Pi Pico 2 W.
#
# Prints one JSON line per 100 ms window over USB serial:
#   {"seq": 12, "t_ms": 34567, "vsys_v": 6.168}
#
# vsys_v: averaged VSYS reading (uncalibrated; only changes matter). When the TT
# motor stalls it draws more current and VSYS sags ~0.07 V. Measured on Suvan's
# laptop port: ~6.168 spinning, ~6.099 stopped (threshold ~6.130). Re-check the
# levels if the USB port/cable changes.
#
# Wiring: motor red->40 (VBUS), black->38 (GND), 100 uF across the motor.
# Nothing above 3.3 V touches a GPIO.
import sys
import time

from machine import ADC, Pin

WINDOW_MS = 100
VSYS_SCALE = 3 * 3.3 / 65535

# Pico W boards share GP29 with the wireless chip; GP25 high deselects it so
# ADC3 reads VSYS/3. WiFi is never used by this firmware.
Pin(25, Pin.OUT, value=1)
Pin(29, Pin.IN)
vsys_adc = ADC(3)


def read_window():
    total, n = 0, 0
    end = time.ticks_add(time.ticks_ms(), WINDOW_MS)
    while time.ticks_diff(end, time.ticks_ms()) > 0:
        total += vsys_adc.read_u16()
        n += 1
    return total / n * VSYS_SCALE


def main():
    seq = 0
    while True:
        vsys = read_window()
        sys.stdout.write('{"seq":%d,"t_ms":%d,"vsys_v":%.4f}\n' % (seq, time.ticks_ms(), vsys))
        seq += 1


try:
    main()
except KeyboardInterrupt:
    pass
