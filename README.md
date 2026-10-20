# Sim Motorsport Data

Private AIM telemetry viewer for motorcycle track coaching. Open an `.xrk` from an AIM Solo, place sectors along the lap, and see the ideal lap made from the best sector of each lap. At Zhuhai International Circuit the built-in C1–C11 map, a GPS track with a live cursor, a time-delta trace, and a one-page coaching note sit on top of that.

## Use it

Download `index.html` from this repo. Double-click the saved file. It opens in Chrome or Edge. No install.

1. Click **Open file** and choose an `.xrk` (or a Dragy `.vbo`).
2. Choose **ZIC C1–C11** and click **Apply**. Corners are placed by distance along the lap, and sector times use those names. Drag a marker if a corner sits a few metres off; this browser remembers the edit for that track.
3. Check two laps, or one lap to compare against the best other lap. Mark the reference with **Ref**. The delta chart is cumulative time versus distance: positive is behind the reference, negative is ahead.
4. Hover the delta chart, the split bar, or the brake / throttle / lean plots. The dot on the track map is that distance along the lap, and dragging the map moves the cursor back onto the charts. Two checked laps draw both paths; the filled dot is the lap marked **Ref** and the other lap is a ring at the same distance. With **ZIC C1–C11** applied, the map labels C1–C11.
5. Brake, throttle, and lean are the overlays that come up first. Triangles are brake-on. Diamonds are apexes.
6. **Export PNG** or **Export PDF** writes a one-page note: laps, C1–C11 times and deltas, the three biggest sector losses, the delta trace, and the brake / throttle / lean overlays.

Speed is shown in km/h. Splits follow GPS distance, so a sector is the same piece of track on every lap. The ideal time is the sum of the fastest sector times, including the straights between named corners.

Manual percentage splits are still there. **Divide lap**, **Clear**, and **Apply → Manual splits** use that mode. **Save template** keeps the current corners under a name in this browser.

## On Railway

Link this GitHub repo with **Deploy from GitHub**. After it is linked, every push to `main` deploys on its own. Open the public `https://` address Railway shows for the service. That page is this `index.html`.

`.xrk` and `.vbo` files stay on your computer. **Open file** reads them in the browser. They are not uploaded to Railway.

## Edit later

`src/standalone.ts` is the source of `index.html`. `src/lib/telemetry.ts` is the sector maths, including the ZIC corner distances. `src/components/viewer.tsx` and `src/components/trace-plot.tsx` are the same coaching desk in component form.

Rebuild the single file with `npm install` and `npm run build`. That step is only for editing. The page itself does not need it.
