# DataCenterOS fan sensor firmware (HW-2), MicroPython on Raspberry Pi Pico 2 W.
# Every 100 ms prints SPINNING or STOPPED over USB serial.
# Signal: VSYS sags when the motor stalls (~6.168 spinning, ~6.099 stopped).
# THRESHOLD is tuned for Suvan's laptop USB port; re-check if the port/cable changes.
import time
from machine import ADC, Pin

THRESHOLD = 6.130
WINDOW_MS = 100
VSYS_SCALE = 3 * 3.3 / 65535

Pin(25, Pin.OUT, value=1)   # W boards: lets ADC3 read VSYS (WiFi unused)
Pin(29, Pin.IN)
vsys_adc = ADC(3)


def read_vsys():
    total, n = 0, 0
    end = time.ticks_add(time.ticks_ms(), WINDOW_MS)
    while time.ticks_diff(end, time.ticks_ms()) > 0:
        total += vsys_adc.read_u16()
        n += 1
    return total / n * VSYS_SCALE


try:
    while True:
        print("SPINNING" if read_vsys() > THRESHOLD else "STOPPED")
except KeyboardInterrupt:
    pass
