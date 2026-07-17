# GolfSense

A Python desktop application for golf swing analysis using the WitMotion
BWT901CL IMU sensor. Runs as a local Flask + WebSocket server and opens
automatically in Chrome as a full-screen dashboard.

Includes clones of the WitMotion Minimu.exe utility panels (Raw Data,
Waveforms, Attitude, 3D Sensor, Configuration, Recording), plus the
GolfSense golf analysis dashboard: a live 3D driver head, swing replay with
a 3D arc and scrubber, impact zone / strike map, ball flight prediction,
and a swing-fault diagnosis engine with coaching tips.

A built-in **Demo Sensor** simulates a BWT901CL with a scripted swing
motion, so the whole app can be explored without any physical hardware.

## Requirements

- Python 3.10+ (tested on 3.14)
- Google Chrome (the app launches into it automatically; falls back to your
  default browser if Chrome isn't found)
- A WitMotion BWT901CL sensor if you want to use real hardware - otherwise
  just use the Demo Sensor

## Setup

```bash
cd golfsense
pip install -r requirements.txt
```

## Run

```bash
python app.py
```

This starts the server at `http://127.0.0.1:5000` and opens it in a new
full-screen Chrome window. Pass `--no-browser` to skip the auto-launch and
just open the URL yourself:

```bash
python app.py --no-browser
```

On first load, use the connection panel to connect either a real sensor
(auto-detected COM port) or the **Demo Sensor** entry, which is always
available for testing.

## Using the GolfSense golf view

1. Mount the sensor on the driver's hosel (see the sensor setup notes in
   `swing_analyzer.py` / the in-app Configuration view for axis alignment).
2. Connect to the sensor.
3. Hold the club at address and click **Calibrate / Set Zero** in the top
   bar - this zeroes the sensor's angle reference and records the address
   quaternion so all subsequent swing metrics are relative deltas from it.
4. Swing. Swings are detected automatically; each one populates the 3D
   driver head, swing replay, impact zone, ball flight prediction, and
   diagnosis panels, and gets added to the session history strip at the
   bottom.

## Recording and playback

The Recording view can capture the full 200Hz sensor stream to a
timestamped `.gsw` file (a simple newline-delimited-JSON format, not
WitMotion's proprietary binary layout, which isn't published). Recordings
can be replayed back through the entire app - including swing re-detection
and analysis - at 0.25x-4x speed, and exported to CSV.

## Project structure

```
golfsense/
  app.py              Flask server, sensor connection manager, WebSocket broadcast
  sensor.py            BWT901CL protocol parser, COM port scanner, Demo Sensor
  swing_analyzer.py    Swing start/end detection, arc-bottom (impact) detection
  ball_flight.py       Ball flight physics/prediction engine
  diagnosis.py         Swing fault rule engine
  static/
    index.html         Full dashboard (all views)
    css/style.css
    js/
      app.js            Core: socket connection, calibration, toasts
      witmotion.js       WitMotion-clone views (Raw Data, Waveforms, Attitude,
                         3D Sensor, Configuration, Recording)
      golfsense.js       Golf panels: impact zone, ball flight, diagnosis,
                         session history
      three_driver.js    Live 3D driver head (Panel 1)
      three_swing.js     3D swing arc replay (Panel 2)
  sessions/             Recorded .gsw sessions and .csv exports (gitignored)
```

## Notes on hardware accuracy

- The WitMotion binary frame **parsing** (0x55-header packets for
  acceleration/gyro/angle/magnetometer/quaternion/time) follows the stable,
  widely-documented part of the protocol.
- The **configuration command** register addresses (output rate, bandwidth,
  algorithm, calibration, etc.) follow the commonly published WitMotion
  command set, but haven't been verified against physical BWT901CL
  hardware in this environment. If a specific command doesn't visibly take
  effect on your unit, cross-check the register address against WitMotion's
  official serial protocol document.
- Swing physics (speed, ball flight, attack angle) are derived entirely
  from the sensor's orientation and acceleration stream - there's no
  position/GPS tracking - so treat distance and speed numbers as rough
  estimates, not calibrated launch-monitor output.
