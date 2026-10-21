# Sim Motorsport Data

Private telemetry viewer for motorcycle track coaching. Open an AIM `.xrk`, a Dragy `.vbo`, a SpeedAngle `.sa`, or an I2M Chrome / DataLog `.dat`, place sectors along the lap, and see the ideal lap made from the best sector of each lap. At Zhuhai International Circuit the built-in C1–C11 map, a GPS track with a live cursor, a time-delta trace, and a one-page coaching note sit on top of that.

## Use it

Download `index.html` from this repo. Double-click the saved file. It opens in Chrome or Edge. No install.

1. Click **Open file** and choose an AIM `.xrk`, a Dragy `.vbo`, a SpeedAngle `.sa` from the R4 download, or an I2M Chrome / DataLog `.dat`.
2. Choose **ZIC C1–C11** and click **Apply**. Corners are placed by distance along the lap, and sector times use those names. Drag a marker if a corner sits a few metres off; this browser remembers the edit for that track.
3. Check two laps, or one lap to compare against the best other lap. Mark the reference with **Ref**. The delta chart is cumulative time versus distance: positive is behind the reference, negative is ahead.
4. Hover the delta chart, the split bar, or the brake / throttle / lean plots. The dot on the track map is that distance along the lap, and dragging the map moves the cursor back onto the charts. Two checked laps draw both paths; the filled dot is the lap marked **Ref** and the other lap is a ring at the same distance. With **ZIC C1–C11** applied, the map labels C1–C11.
5. Brake, throttle, and lean are the overlays that come up first. Triangles are brake-on. Diamonds are apexes.
6. **Export PNG** or **Export PDF** writes a one-page note: laps, C1–C11 times and deltas, the three biggest sector losses, the delta trace, and the brake / throttle / lean overlays.

Speed is shown in km/h. Splits follow GPS distance, so a sector is the same piece of track on every lap. The ideal time is the sum of the fastest sector times, including the straights between named corners.

A SpeedAngle `.sa` splits laps on finish-line marks. GPS speed, lean angle, and longitudinal G come up on open. Longitudinal G is the brake and accel trace when the log has no brake pressure: negative G is braking. The trace speed column is miles per hour when the GPS trace agrees, and those numbers are converted to km/h. A unit field on its own header line (`Unit: KMH` or `Unit: MPH`) wins over that. Longitudinal G is stored in steps of 0.02 G. A track or file name that says Zhuhai or ZIC applies C1–C11 on open.

An I2M `.dat` is the text session Chrome and DataLog Pro write (`$NEW SESSION`, `$SETTINGS`, `$GPS`, `$VALUE`). It opens in the browser; Danas is not required. GPS speed is knots and is shown in km/h. At Zhuhai the start/finish is the fast fix nearest 22.3671 N, 113.5601 E, and C1–C11 applies on open. Several sessions in one file keep their finished laps and drop a short pit session.

Channels from a Zhuhai Chrome log:

| Channel | What you see |
| --- | --- |
| GPS Speed, latitude, longitude, altitude | 10 Hz fixes. Speed was knots. |
| APS Throttle | First `$SETTINGS` channel, here accelerator position. 0 V is the minimum and count 1023 is the maximum, so count 200 with max 512 is 100%. |
| TPS H, TPS V, 2ANALOG, 3ANALOG, 4ANALOG, LAMBDA INT., 6ANALOG | Same 0–5 V scaling, under the name and min/max stored in the file. TPS H/V are not the grip trace. 2ANALOG spans −900 to 123, so a mid-scale count is still largely negative (count 582 is −318) and full scale is only 123. 3ANALOG sits near one count. |
| Rear Speed | Wheel-speed period (column 4) with the 1950 mm circumference and a 39062.5 Hz timer. It tracks GPS within about 1 km/h. |
| Pinion Speed | Column 3 through the 16/38 sprockets. A few percent faster than GPS on this bike. |
| RPM Period | Column 5, raw timer counts. The file has no engine timebase, so this is not rpm. It is high when the bike is slow. |
| Lean Angle | The logged lean and pitch channels do not move. Lean is GPS-derived, positive to the right, and clamped to ±65°. |
| Longitudinal G | There is no channel named brake. This is the change in GPS speed. Negative is braking. |
| TorqueRed S, TorqueRed F | Scaled like the other 0–1023 channels. They are zero except for small spikes. The free-running 65535 counters are not shown. |

Manual percentage splits are still there. **Divide lap**, **Clear**, and **Apply → Manual splits** use that mode. **Save template** keeps the current corners under a name in this browser.

## On Railway

Link this GitHub repo with **Deploy from GitHub**. After it is linked, every push to `main` deploys on its own. Open the public `https://` address Railway shows for the service. That page is this `index.html`.

`.xrk`, `.vbo`, `.sa`, and `.dat` files stay on your computer. **Open file** reads them in the browser. They are not uploaded to Railway.

## Edit later

`src/standalone.ts` is the source of `index.html`. `src/lib/telemetry.ts` is the sector maths, including the ZIC corner distances. `src/lib/i2m-dat.ts` reads Chrome / DataLog `.dat` sessions. `src/components/viewer.tsx` and `src/components/trace-plot.tsx` are the same coaching desk in component form.

Rebuild the single file with `npm install` and `npm run build`. That step is only for editing. The page itself does not need it.
