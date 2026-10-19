# Sim Motorsport Data

Private AIM telemetry viewer. Open an `.xrk` from an AIM Solo, place splits along the lap, and see the ideal lap made from the best sector of each lap.

## Use it

Download `index.html` from this repo. Double-click the saved file. It opens in Chrome or Edge. No install.

Click **Open .xrk** and choose a session. Speed is shown in km/h. Splits follow GPS distance, so a sector is the same piece of track on every lap. The ideal time is the sum of the fastest sector times.

Splits are remembered in that browser for the same track.

## Edit later

`src/standalone.ts` is the source of `index.html`. `src/lib/telemetry.ts` is the sector maths.
