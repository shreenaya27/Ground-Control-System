/* ==========================================================
   CHARTS.JS
   Real-time Chart.js telemetry graphs (Altitude, Pressure,
   Temperature, Battery Voltage, Descent Rate) for the
   CanSat Ground Control System.

   Architecture:
     - Charts are created exactly ONCE (initializeCharts).
     - Every telemetry packet only pushes/shifts data into the
       existing Chart.js dataset arrays — charts are NEVER
       destroyed or recreated (pushTelemetryPoint / updateGraphs).
     - A tab bar lets the operator view one graph at a time
       without losing data in the hidden charts (switchGraph).
     - Data source: this module listens for the 'gcs:update'
       custom event dispatched elsewhere in the app (e.g. from
       app.js / telemetry.js) whenever a new telemetry packet
       arrives. The event detail carries the current values for
       altitude, pressure, temperature, batteryVoltage and
       descentRate.
========================================================== */

window.GCS = window.GCS || {};

(function (GCS) {

    'use strict';

    /* ----------------------------------------------------------
       CONFIG
    ---------------------------------------------------------- */

    // Rolling window size: keep only the latest N points per graph
    const MAX_POINTS = 50;

    // One entry per graph. `pick` extracts the correct value from
    // the telemetry event payload for that series.
    // NOTE: the 'gcs:update' event detail is the FULL telemetry
    // state object from telemetry.js (state.container.*, state.payload.*),
    // not a flat { altitude, pressure, ... } shape. `pick` must reach
    // into the correct nested branch or every value comes back
    // `undefined` and pushTelemetryPoint silently no-ops (which is
    // exactly what was happening — charts rendered, but no points
    // were ever plotted).
    const SERIES = {
        altitude: {
            canvasId: 'altitudeChart',
            color: '#4FC3F7',           // Blue
            label: 'Altitude (m)',
            pick: (t) => t.container?.altitude
        },
        pressure: {
            canvasId: 'pressureChart',
            color: '#4ADE80',           // Green
            label: 'Pressure (hPa)',
            pick: (t) => t.container?.pressure
        },
        temperature: {
            canvasId: 'temperatureChart',
            color: '#FFB74D',           // Orange
            label: 'Temperature (°C)',
            pick: (t) => t.container?.temperature
        },
        battery: {
            canvasId: 'batteryChart',
            color: '#FFD54F',           // Yellow
            label: 'Battery Voltage (V)',
            pick: (t) => t.container?.battery
        },
        descent: {
            canvasId: 'descentChart',
            color: '#FF5252',           // Red
            label: 'Descent Rate (m/s)',
            pick: (t) => t.payload?.descentRate
        }
    };

    // Holds the live Chart.js instances, keyed by series key.
    // Created once in initializeCharts() and never re-created.
    const charts = {};

    // Currently visible graph key.
    let activeKey = 'altitude';

    /* ----------------------------------------------------------
       HELPERS
    ---------------------------------------------------------- */

    // Shared Chart.js options for every graph (dark theme, no
    // per-frame animation so live updates stay smooth/instant).
    function baseChartOptions() {
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { intersect: false, mode: 'index' },
            scales: {
                x: {
                    ticks: { color: '#7C8FAE', maxTicksLimit: 6 },
                    grid: { color: '#1C2A3F' }
                },
                y: {
                    ticks: { color: '#7C8FAE' },
                    grid: { color: '#1C2A3F' }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: { enabled: true }
            }
        };
    }

    // Builds a x-axis label for a new point. Falls back to a
    // local HH:MM:SS clock if no mission-elapsed-time is given.
    function makeLabel(metSeconds) {
        if (typeof metSeconds === 'number') {
            const h = String(Math.floor(metSeconds / 3600)).padStart(2, '0');
            const m = String(Math.floor((metSeconds % 3600) / 60)).padStart(2, '0');
            const s = String(Math.floor(metSeconds % 60)).padStart(2, '0');
            return `${h}:${m}:${s}`;
        }
        return new Date().toLocaleTimeString('en-GB');
    }

    /* ----------------------------------------------------------
       createChart(key)
       Creates a single Chart.js line chart for the given series
       key and stores it in `charts`. Called only from
       initializeCharts() — never called again afterwards.
    ---------------------------------------------------------- */
    function createChart(key) {
        const cfg = SERIES[key];
        const canvas = document.getElementById(cfg.canvasId);

        if (!canvas || !window.Chart) return;

        charts[key] = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: cfg.label,
                    data: [],
                    borderColor: cfg.color,
                    backgroundColor: cfg.color + '22',
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    tension: 0.3,
                    fill: true
                }]
            },
            options: baseChartOptions()
        });
    }

    /* ----------------------------------------------------------
       initializeCharts()
       Creates all five charts ONCE and wires up the tab buttons.
       Must be called a single time during page/app startup.
    ---------------------------------------------------------- */
    function initializeCharts() {
        Object.keys(SERIES).forEach(createChart);

        document.querySelectorAll('.graph-tab').forEach((btn) => {
            btn.addEventListener('click', () => switchGraph(btn.dataset.graph));
        });

        // Listen for telemetry updates dispatched by the rest of
        // the app (e.g. document.dispatchEvent(new CustomEvent(
        // 'gcs:update', { detail: { altitude, pressure, ... } })))
        document.addEventListener('gcs:update', (e) => updateGraphs(e.detail));
    }

    /* ----------------------------------------------------------
       pushTelemetryPoint(key, label, value)
       Appends one data point to an existing chart's dataset and
       trims it to the rolling MAX_POINTS window. Only calls
       chart.update('none') — never destroys/recreates the chart.
    ---------------------------------------------------------- */
    function pushTelemetryPoint(key, label, value) {
        const chart = charts[key];
        if (!chart || value === undefined || value === null || Number.isNaN(value)) return;

        const data = chart.data;
        data.labels.push(label);
        data.datasets[0].data.push(Number(value.toFixed ? value.toFixed(2) : value));

        if (data.labels.length > MAX_POINTS) {
            data.labels.shift();
            data.datasets[0].data.shift();
        }

        // 'none' skips animation so rapid updates never flicker
        chart.update('none');
    }

    /* ----------------------------------------------------------
       updateGraphs(telemetry)
       Called once per telemetry packet. Reads the current global
       telemetry values and pushes a new point onto every graph.
       `telemetry` may be the event detail object, or omitted to
       fall back to the global variables described in the spec
       (altitude, pressure, temperature, batteryVoltage,
       descentRate).
    ---------------------------------------------------------- */
    function updateGraphs(telemetry) {
        const t = telemetry || {
            altitude: window.altitude,
            pressure: window.pressure,
            temperature: window.temperature,
            batteryVoltage: window.batteryVoltage,
            descentRate: window.descentRate,
            metSeconds: window.metSeconds
        };

        const label = makeLabel(t.metSeconds);

        Object.keys(SERIES).forEach((key) => {
            pushTelemetryPoint(key, label, SERIES[key].pick(t));
        });
    }

    /* ----------------------------------------------------------
       switchGraph(key)
       Shows only the selected graph's canvas and highlights its
       tab. Never recreates any chart — hidden charts keep their
       data intact so switching back shows the same history.
    ---------------------------------------------------------- */
    function switchGraph(key) {
        if (!SERIES[key]) return;
        activeKey = key;

        document.querySelectorAll('.graph-tab').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.graph === key);
        });

        document.querySelectorAll('.graph-slot').forEach((slot) => {
            const canvas = slot.querySelector('canvas');
            slot.hidden = canvas.id !== SERIES[key].canvasId;
        });

        // Chart.js needs a resize nudge after being un-hidden,
        // since canvases report zero size while `hidden`.
        const chart = charts[key];
        if (chart) chart.resize();
    }

    /* ----------------------------------------------------------
       PUBLIC API
    ---------------------------------------------------------- */
    GCS.charts = {
        init: initializeCharts,   // alias so app.js's GCS.charts?.init() resolves correctly
        initializeCharts,
        createChart,
        pushTelemetryPoint,
        updateGraphs,
        switchGraph,
        getActiveKey: () => activeKey,
        getActiveCanvasId: () => SERIES[activeKey].canvasId
    };

})(window.GCS);

/* ==========================================================
   NOTE: charts are now initialized centrally by app.js's
   DOMContentLoaded handler (GCS.charts.init()), alongside
   every other module (map, orientation, video, controls).
   The old standalone DOMContentLoaded listener that used to
   live here has been removed — keeping it would have caused
   initializeCharts() to run TWICE (once here, once via
   app.js), and Chart.js throws "Canvas is already in use"
   the second time a chart is created on the same <canvas>.
========================================================== */
