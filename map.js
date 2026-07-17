/* ==========================================================
   MAP.JS
   Leaflet ground-track map fed by the 'gcs:update' event.

   Responsibilities:
     - Create the map, a FIXED green launch-site marker, and a
       MOVING payload marker exactly ONCE (init). Nothing is ever
       destroyed/recreated afterwards — every subsequent update
       only calls setLatLng() / setStyle() / setLatLngs(), so
       this stays cheap even at high packet rates and never leaks
       Leaflet objects or duplicates the map instance.
     - Grow a Leaflet polyline with the full mission trajectory,
       skipping near-duplicate consecutive points, and keep it
       visible for the rest of the session (including after
       landing) — the complete path history is never cleared.
     - Smooth the raw simulated GPS coordinates with a light
       exponential moving average before they ever reach the
       marker/trail/distance math, so the ground track reads as
       a realistic flight path instead of a jittery zig-zag. This
       is purely a display-layer filter — it never mutates
       GCS.state, so telemetry.js / the CSV export / error.js
       still see the raw sensor values.
     - Recolor the payload marker by GPS fix quality (green = 3D,
       orange = 2D, grey = No Fix), pause trajectory growth while
       there is no fix (position isn't trustworthy), and switch to
       a dedicated red "landed" marker once the mission touches
       down — after which the marker holds at the touchdown site.
     - Keep the payload near the center of the map on every valid
       fix using an animated panTo(), which (unlike setView) never
       touches the operator's current zoom level.
     - Accumulate the total ground distance travelled (Haversine
       great-circle distance between consecutive trusted trail
       points) and surface it under the Lat/Lng readout.
     - Surface informative popups: the launch marker shows the
       fixed launch coordinates plus mission-start info, and the
       payload marker shows live position, altitude, GPS fix
       status, battery voltage, mission phase and MET — refreshed
       via setPopupContent() so it never reopens or repositions.
     - Render a compact legend explaining the two markers and the
       trajectory line.
     - Log the handful of GPS events the mission console cares
       about (tracking started, signal lost/restored, landed) via
       GCS.log(), plus a throttled "GPS Updated" line so the
       console isn't flooded at ~1 Hz telemetry rates.

   This module only reads GCS.state / the 'gcs:update' event
   detail and only writes to its own map/markers/polyline/legend/
   distance-readout DOM and the console log — it never touches
   telemetry, charts, export, controls, orientation or error.js
   state, and it never recreates the map after init().
========================================================== */

window.GCS = window.GCS || {};

(function (GCS) {

    'use strict';

    /* ----------------------------------------------------------
       CONFIG
    ---------------------------------------------------------- */

    // Rolling cap on trail points. Generous on purpose — the brief
    // wants the full mission path to remain visible, so this is a
    // safety ceiling against unbounded memory growth on very long
    // sessions rather than a "recent window" like the chart graphs use.
    const MAX_TRAIL = 2000;

    // Only emit a console "GPS Updated" line every Nth valid fix —
    // logging every ~1 Hz packet would drown out everything else
    // in the mission console.
    const GPS_LOG_INTERVAL = 15;

    // Exponential-moving-average factor applied to raw lat/lng
    // before it touches the marker, trail or distance math. Lower
    // = smoother/slower to follow, higher = snappier/more jittery.
    // 0.3 keeps the track visibly responsive while erasing the
    // simulator's per-tick +/-0.00004 deg random walk noise.
    const SMOOTHING_ALPHA = 0.3;

    // Minimum real-world movement (meters) before a smoothed point
    // is added to the trail / distance total. Filters out the
    // residual sub-meter smoothing noise that would otherwise still
    // zig-zag the polyline and inflate the distance readout while
    // the payload is essentially stationary.
    const MIN_TRAIL_STEP_M = 0.4;

    // Marker color/label per GPS fix quality (assignment brief).
    const FIX_STYLE = {
        '3D':     { color: '#4ADE80', label: '3D Fix' },  // green
        '2D':     { color: '#FFB74D', label: '2D Fix' },  // orange
        'No Fix': { color: '#7C8FAE', label: 'No Fix' }   // grey
    };

    // Dedicated style once the mission has landed — takes priority
    // over whatever the live fix quality happens to be.
    const LANDED_STYLE = { color: '#FF5252', label: 'Landed' }; // red

    const LAUNCH_COLOR = '#4ADE80'; // green — distinct from the live payload colors

    function fixStyle(fix) {
        return FIX_STYLE[fix] || FIX_STYLE['No Fix'];
    }

    /* ----------------------------------------------------------
       MODULE STATE
    ---------------------------------------------------------- */

    let map, payloadMarker, launchMarker, path;
    const trail = [];

    let launchPos = null;      // fixed [lat, lng] captured once at init — the launch marker never moves
    let lastFix = null;        // previous GPS fix string, to detect lost/restored transitions
    let lastGoodPos = null;    // last trusted (smoothed + de-jittered) position added to the trail
    let smoothedPos = null;    // running EMA of [lat, lng], independent of GCS.state
    let updateCount = 0;       // counts valid-fix updates, drives the GPS-Updated throttle
    let landedHandled = false; // guards the one-time "Mission Landed" transition
    let totalDistanceM = 0;    // cumulative great-circle distance travelled
    let missionStartTime = null; // Date captured the first time telemetry goes live

    /* ----------------------------------------------------------
       Small geo/format helpers
    ---------------------------------------------------------- */

    // Haversine great-circle distance in meters between two
    // [lat, lng] pairs.
    function haversineMeters(a, b) {
        const R = 6371000;
        const toRad = (d) => d * Math.PI / 180;
        const dLat = toRad(b[0] - a[0]);
        const dLng = toRad(b[1] - a[1]);
        const lat1 = toRad(a[0]);
        const lat2 = toRad(b[0]);

        const h = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    function formatDistance(meters) {
        if (meters < 1000) return `${meters.toFixed(0)} m`;
        return `${(meters / 1000).toFixed(2)} km`;
    }

    function updateDistanceReadout() {
        GCS.util.setText('gps-distance', formatDistance(totalDistanceM));
    }

    /* ----------------------------------------------------------
       Popup content builders
       Rebuilt on every update via setPopupContent — never rebinds
       or reopens either popup, so it's safe to call every tick.
    ---------------------------------------------------------- */
    function launchPopupHtml(startPos) {
        const startedLabel = missionStartTime
            ? missionStartTime.toLocaleTimeString('en-GB', { hour12: false })
            : 'Standing by';

        return (
            '<div class="gps-popup">' +
                '<strong>🟢 Launch Site</strong><br>' +
                'Position: ' + startPos[0].toFixed(6) + ', ' + startPos[1].toFixed(6) + '<br>' +
                'Mission Start: ' + startedLabel +
            '</div>'
        );
    }

    function payloadPopupHtml(state, pos) {
        const c = state.container;
        const p = state.payload;
        const style = landedHandled ? LANDED_STYLE : fixStyle(c.gpsFix);

        const posLabel = pos
            ? `${pos[0].toFixed(6)}, ${pos[1].toFixed(6)}`
            : 'Acquiring…';

        return (
            '<div class="gps-popup">' +
                '<strong>🛰 Payload — ' + state.phase.charAt(0) + state.phase.slice(1).toLowerCase() + '</strong><br>' +
                'Position: ' + posLabel + (c.gpsFix === 'No Fix' && !landedHandled ? ' <em>(last known)</em>' : '') + '<br>' +
                'Altitude: ' + c.altitude.toFixed(1) + ' m<br>' +
                'GPS: ' + style.label + ' (' + c.sats + ' sats)<br>' +
                'Battery: ' + p.battery.toFixed(2) + ' V<br>' +
                'MET: ' + GCS.util.fmtClock(state.metSeconds) +
            '</div>'
        );
    }

    /* ----------------------------------------------------------
       Legend
       Static content, built once — mirrors LAUNCH_COLOR/FIX_STYLE/
       LANDED_STYLE above so it can never fall out of sync with the
       live marker colors.
    ---------------------------------------------------------- */
    function renderLegend() {
        const el = document.getElementById('map-legend');
        if (!el) return;

        el.innerHTML =
            '<div class="legend-item">' +
                '<span class="legend-swatch legend-swatch--diamond" style="--swatch-color:' + LAUNCH_COLOR + '"></span>' +
                '<span>Launch Site (fixed)</span>' +
            '</div>' +
            '<div class="legend-item">' +
                '<span class="legend-swatch legend-swatch--dot" style="--swatch-color:' + FIX_STYLE['3D'].color + '"></span>' +
                '<span>Payload — color reflects GPS fix (green 3D / orange 2D / grey No Fix / red landed)</span>' +
            '</div>' +
            '<div class="legend-item">' +
                '<span class="legend-swatch legend-swatch--line"></span>' +
                '<span>Flight Path (trajectory)</span>' +
            '</div>';
    }

    /* ----------------------------------------------------------
       createMarkers(state)
       Creates the fixed launch marker, the moving payload marker
       and the trajectory polyline exactly once. Called only from
       init() — never called again afterwards.
    ---------------------------------------------------------- */
    function createMarkers(state) {
        const c = state.container;
        const start = [c.lat, c.lng];

        // Fixed launch-site marker — a small green diamond that
        // never moves, distinct from any payload marker color.
        launchMarker = L.marker(start, {
            icon: L.divIcon({
                className: 'gcs-launch-marker',
                html: '<div style="width:14px;height:14px;background:#0B121F;' +
                      'border:2px solid ' + LAUNCH_COLOR + ';transform:rotate(45deg);' +
                      'box-shadow:0 0 6px ' + LAUNCH_COLOR + ';"></div>',
                iconSize: [14, 14],
                iconAnchor: [7, 7]
            }),
            keyboard: false
        }).addTo(map);
        launchMarker.bindPopup(launchPopupHtml(start));

        // Moving payload marker — recolored via setStyle(), moved via
        // setLatLng(). Never destroyed/recreated after this point.
        payloadMarker = L.circleMarker(start, {
            radius: 7,
            color: fixStyle(c.gpsFix).color,
            fillColor: fixStyle(c.gpsFix).color,
            fillOpacity: 0.9,
            weight: 2
        }).addTo(map);
        payloadMarker.bindPopup(payloadPopupHtml(state, start));

        // Trajectory — grown in place with setLatLngs(), never rebuilt.
        // Clean blue line, slightly heavier weight for a crisper,
        // more "professional instrument" look than a thin hairline.
        path = L.polyline([], { color: '#4FC3F7', weight: 3, opacity: 0.85, lineJoin: 'round' }).addTo(map);
    }

    /* ----------------------------------------------------------
       init()
       Creates the map, markers and polyline ONCE and wires up the
       telemetry listener. Must be called a single time at startup
       (app.js already does this via GCS.map.init()). Guarded so a
       stray second call can never spin up a duplicate Leaflet map.
    ---------------------------------------------------------- */
    function init() {
        if (map) return; // already initialized — never re-create the map

        const el = document.getElementById('map');
        if (!el || !window.L) return;

        const c = GCS.state.container;
        const start = [c.lat, c.lng];

        map = L.map('map', { zoomControl: false, attributionControl: false }).setView(start, 15);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19
        }).addTo(map);

        createMarkers(GCS.state);
        renderLegend();
        updateDistanceReadout();

        launchPos = start.slice();
        smoothedPos = start.slice();
        lastGoodPos = start.slice();
        lastFix = c.gpsFix;

        document.addEventListener('gcs:update', onUpdate);

        GCS.log('GPS Tracking Started', `Launch site fixed at ${start[0].toFixed(6)}, ${start[1].toFixed(6)}`);
    }

    /* ----------------------------------------------------------
       onUpdate(e)
       Runs once per telemetry packet. Never creates/destroys the
       map, markers or polyline — only mutates their existing state.
    ---------------------------------------------------------- */
    function onUpdate(e) {
        if (!map) return;

        const state = e.detail;
        const c = state.container;
        const fix = c.gpsFix;
        const rawPos = [c.lat, c.lng];

        if (!missionStartTime && state.running) missionStartTime = new Date();

        // ---- Smooth the raw simulated position (display-layer only) ----
        smoothedPos = [
            smoothedPos[0] + (rawPos[0] - smoothedPos[0]) * SMOOTHING_ALPHA,
            smoothedPos[1] + (rawPos[1] - smoothedPos[1]) * SMOOTHING_ALPHA
        ];

        // Marker color always reflects fix quality, or the dedicated
        // landed style once the mission has touched down.
        const style = landedHandled ? LANDED_STYLE : fixStyle(fix);
        payloadMarker.setStyle({ color: style.color, fillColor: style.color });

        if (fix !== 'No Fix' && !landedHandled) {
            // Trajectory only grows on a trustworthy fix, past the
            // touchdown point, and only once it has moved a real
            // (non-noise) distance — keeps the path a clean line
            // instead of a jittery zig-zag.
            const stepM = haversineMeters(lastGoodPos, smoothedPos);
            if (stepM >= MIN_TRAIL_STEP_M) {
                trail.push(smoothedPos.slice());
                if (trail.length > MAX_TRAIL) trail.shift();
                path.setLatLngs(trail);

                totalDistanceM += stepM;
                lastGoodPos = smoothedPos.slice();
                updateDistanceReadout();
            }

            payloadMarker.setLatLng(smoothedPos);

            // Keep the payload near the center — animated panTo (not
            // setView) never touches the operator's current zoom
            // level, and the smoothing above keeps this pan gentle
            // and continuous rather than a jumpy chase.
            map.panTo(smoothedPos, { animate: true, duration: 0.6, easeLinearity: 0.25 });
        }

        payloadMarker.setPopupContent(payloadPopupHtml(state, landedHandled ? lastGoodPos : smoothedPos));
        launchMarker.setPopupContent(launchPopupHtml(launchPos));

        // ---- GPS event logging ----
        if (lastFix !== fix) {
            if (fix === 'No Fix') {
                GCS.log('GPS Signal Lost', 'Payload GPS fix lost — trajectory paused');
            } else if (lastFix === 'No Fix') {
                GCS.log('GPS Restored', `${style.label} reacquired (${c.sats} satellites)`);
            }
            lastFix = fix;
        } else if (fix !== 'No Fix' && !landedHandled) {
            updateCount++;
            if (updateCount % GPS_LOG_INTERVAL === 0) {
                GCS.log('GPS Updated', `${smoothedPos[0].toFixed(6)}, ${smoothedPos[1].toFixed(6)} — ${style.label}, ${c.sats} sats`);
            }
        }

        // ---- Landing ----
        if (state.phase === 'LANDED' && !landedHandled) {
            landedHandled = true;
            payloadMarker.setStyle({ color: LANDED_STYLE.color, fillColor: LANDED_STYLE.color, weight: 3 });
            payloadMarker.setRadius(9);
            payloadMarker.setLatLng(lastGoodPos);
            map.panTo(lastGoodPos, { animate: true, duration: 0.8, easeLinearity: 0.25 });
            GCS.log('Mission Landed', `Touchdown at ${lastGoodPos[0].toFixed(6)}, ${lastGoodPos[1].toFixed(6)} — total distance ${formatDistance(totalDistanceM)}`);
        }
    }

    GCS.map = { init };

})(window.GCS);