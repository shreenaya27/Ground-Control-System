/* ==========================================================
   VIDEO.JS
   Payload camera feed: device enumeration + selection, live
   MediaDevices stream acquisition, dynamic camera switching,
   and camera telemetry (name / FPS / resolution / latency /
   status) rendered into the existing Camera panel.

   Status lifecycle (mirrored into #camera-status and the
   Mission Console):
     NO SIGNAL -> CONNECTING... -> STREAMING
                                 -> CAMERA STOPPED   (user stop)
                                 -> CAMERA DISCONNECTED (device removed)
                                 -> PERMISSION DENIED (user blocked access)
                                 -> NO CAMERA FOUND   (no videoinput devices)
                                 -> CAMERA ERROR      (any other getUserMedia failure)

   Stays decoupled from the rest of the app: reads nothing from
   GCS.state, only listens for 'gcs:update' (to stamp the camera
   timestamp overlay) and writes through GCS.util / GCS.log.
========================================================== */

window.GCS = window.GCS || {};

(function (GCS) {

    'use strict';

    let videoEl, canvas, ctx, stream, drawRAF;
    let live = false;
    let connecting = false;
    let frameCount = 0;
    let lastFpsSample = performance.now();
    let currentDeviceId = null;
    let currentDeviceLabel = null;

    /* ----------------------------------------------------------
       STATUS HELPERS
       Every status string also gets a color class on #camera-status
       so the operator gets an at-a-glance health read, same
       convention as the rest of the telemetry values.
    ---------------------------------------------------------- */

    const STATUS_COLOR = {
        'NO SIGNAL': 'val-red',
        'CONNECTING…': 'val-amber',
        'STREAMING': 'val-green',
        'CAMERA STOPPED': 'val-red',
        'CAMERA DISCONNECTED': 'val-red',
        'PERMISSION DENIED': 'val-red',
        'NO CAMERA FOUND': 'val-amber',
        'CAMERA ERROR': 'val-red'
    };

    function setStatus(status) {
        const el = document.getElementById('camera-status');
        if (!el) return;
        el.textContent = status;
        el.classList.remove('val-green', 'val-amber', 'val-red', 'val-blue');
        el.classList.add(STATUS_COLOR[status] || 'val-red');
    }

    function setNoSignal(status) {
        const overlay = document.querySelector('.camera-nosignal');
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.textContent = status && status !== 'NO SIGNAL' ? status : 'NO SIGNAL';
        }
        GCS.util.setText('camera-fps', '--');
        GCS.util.setText('camera-resolution', '--');
        GCS.util.setText('camera-latency', '-- ms');
        setStatus(status || 'NO SIGNAL');

        const rec = document.getElementById('rec-indicator');
        if (rec) rec.style.opacity = '0.35';
    }

    function setLive(width, height) {
        const overlay = document.querySelector('.camera-nosignal');
        if (overlay) overlay.style.display = 'none';
        GCS.util.setText('camera-resolution', `${width}×${height}`);
        setStatus('STREAMING');

        const rec = document.getElementById('rec-indicator');
        if (rec) rec.style.opacity = '1';
    }

    function setCameraName(label) {
        currentDeviceLabel = label || null;
        GCS.util.setText('camera-name', label || '--');
    }

    /* ----------------------------------------------------------
       DEVICE ENUMERATION
       Populates the existing #camera-select dropdown. Re-run
       after a permission grant, since device labels are blank
       (privacy) until getUserMedia has succeeded at least once.
    ---------------------------------------------------------- */

    async function listCameras(preserveSelection) {
        const select = document.getElementById('camera-select');
        if (!select || !navigator.mediaDevices?.enumerateDevices) return [];

        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const cams = devices.filter(d => d.kind === 'videoinput');

            const previous = preserveSelection ? select.value : '';
            select.innerHTML = '<option value="">Select camera…</option>';
            cams.forEach((cam, i) => {
                const opt = document.createElement('option');
                opt.value = cam.deviceId;
                opt.textContent = cam.label || `Camera ${i + 1}`;
                select.appendChild(opt);
            });

            if (previous && cams.some(c => c.deviceId === previous)) {
                select.value = previous;
            }

            if (cams.length === 0) {
                GCS.log('Camera Error', 'No camera found on this device');
            } else if (!GCS._cameraListLogged) {
                GCS._cameraListLogged = true;
                GCS.log('Camera Detected', `${cams.length} video input${cams.length > 1 ? 's' : ''} found`);
            }

            return cams;
        } catch (err) {
            // enumeration can fail without a prior permission grant; non-fatal
            return [];
        }
    }

    /* ----------------------------------------------------------
       STREAM LIFECYCLE
    ---------------------------------------------------------- */

    function stopTracksOnly() {
        if (drawRAF) cancelAnimationFrame(drawRAF);
        drawRAF = null;
        if (stream) {
            stream.getTracks().forEach(t => {
                t.removeEventListener('ended', onTrackEnded);
                t.stop();
            });
            stream = null;
        }
    }

    function onTrackEnded() {
        // fires if the OS/browser yanks the device out from under us
        // (unplugged, revoked by another app, etc.) while live
        if (!live) return;
        live = false;
        stopTracksOnly();
        setNoSignal('CAMERA DISCONNECTED');
        GCS.log('Camera Disconnected', currentDeviceLabel ? `${currentDeviceLabel} became unavailable` : 'Active camera became unavailable');
    }

    async function startStream() {
        if (!navigator.mediaDevices?.getUserMedia) {
            setNoSignal('CAMERA ERROR');
            GCS.log('Camera Error', 'Camera API unavailable in this browser');
            return;
        }

        const select = document.getElementById('camera-select');
        const deviceId = select?.value || undefined;

        // switching cameras (or a fresh start) — release whatever is
        // currently held before requesting the new one
        stopTracksOnly();
        live = false;
        connecting = true;
        setStatus('CONNECTING…');

        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: deviceId ? { deviceId: { exact: deviceId } } : true,
                audio: false
            });

            connecting = false;
            live = true;
            currentDeviceId = deviceId || null;
            frameCount = 0;
            lastFpsSample = performance.now();

            videoEl.srcObject = stream;
            await videoEl.play();

            const track = stream.getVideoTracks()[0];
            track?.addEventListener('ended', onTrackEnded);

            const trackLabel = track?.label || select?.selectedOptions?.[0]?.textContent || 'Camera';
            setCameraName(trackLabel);

            drawFrame();
            await listCameras(true); // labels become available after permission grant

            GCS.log('Stream Started', `Live feed acquired from ${trackLabel}`);
        } catch (err) {
            connecting = false;
            live = false;
            currentDeviceId = null;

            if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
                setNoSignal('PERMISSION DENIED');
                GCS.log('Camera Permission Denied', 'Operator denied camera access');
            } else if (err && err.name === 'NotFoundError') {
                setNoSignal('NO CAMERA FOUND');
                GCS.log('Camera Error', 'No matching camera device found');
            } else {
                setNoSignal('CAMERA ERROR');
                GCS.log('Camera Error', (err && err.message) || 'Unable to access camera');
            }
        }
    }

    function stopStream() {
        const wasLive = live;
        live = false;
        connecting = false;
        stopTracksOnly();
        setCameraName(null);
        currentDeviceId = null;
        setNoSignal('CAMERA STOPPED');

        if (wasLive) {
            GCS.log('Stream Stopped', 'Camera stream stopped by operator');
        }
    }

    /* ----------------------------------------------------------
       DYNAMIC CAMERA SWITCHING
       Selecting a different device while already streaming tears
       down the old track and immediately requests the new one —
       no page refresh required.
    ---------------------------------------------------------- */

    function onCameraSelected() {
        const select = document.getElementById('camera-select');
        const label = select?.selectedOptions?.[0]?.textContent || '';
        if (select?.value) {
            GCS.log('Camera Selected', label);
        }
        if (live || connecting) {
            startStream(); // re-acquire against the newly selected deviceId
        }
    }

    /* ----------------------------------------------------------
       FRAME LOOP — draws the live video into the existing canvas
       (preserves the existing overlay/NO SIGNAL design, which is
       layered on top of the canvas in index.html/style.css) and
       samples FPS / simulated glass-to-glass latency.
    ---------------------------------------------------------- */

    function drawFrame() {
        if (!live) return;
        const t0 = performance.now();

        if (videoEl.readyState >= 2) {
            ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
            setLive(videoEl.videoWidth || canvas.width, videoEl.videoHeight || canvas.height);
            frameCount++;
        }

        const elapsed = performance.now() - lastFpsSample;
        if (elapsed >= 1000) {
            GCS.util.setText('camera-fps', Math.round((frameCount * 1000) / elapsed));
            frameCount = 0;
            lastFpsSample = performance.now();
        }

        // real render-loop time plus a small simulated ground-link
        // component, since there is no actual RF downlink in this sim
        GCS.util.setText('camera-latency', Math.round(performance.now() - t0 + Math.random() * 40 + 20) + ' ms');

        drawRAF = requestAnimationFrame(drawFrame);
    }

    /* ----------------------------------------------------------
       TELEMETRY TIMESTAMP OVERLAY
       Purely cosmetic link to the rest of the app — stamps the
       camera overlay with mission-elapsed-time, decoupled via
       the shared 'gcs:update' event only.
    ---------------------------------------------------------- */

    function onUpdate(e) {
        const el = document.getElementById('camera-timestamp');
        if (el) el.textContent = GCS.util.fmtClock(e.detail.metSeconds);
    }

    /* ----------------------------------------------------------
       DEVICE CHANGE (plug/unplug) HANDLING
    ---------------------------------------------------------- */

    function onDeviceChange() {
        listCameras(true);

        // if the camera we were actively using just vanished from the
        // device list entirely, tear the stream down cleanly
        if (currentDeviceId && stream) {
            navigator.mediaDevices.enumerateDevices().then(devices => {
                const stillPresent = devices.some(d => d.kind === 'videoinput' && d.deviceId === currentDeviceId);
                if (!stillPresent && live) {
                    live = false;
                    stopTracksOnly();
                    setNoSignal('CAMERA DISCONNECTED');
                    GCS.log('Camera Disconnected', currentDeviceLabel ? `${currentDeviceLabel} removed` : 'Active camera removed');
                }
            }).catch(() => {});
        }
    }

    /* ----------------------------------------------------------
       INIT
       Called once from app.js's DOMContentLoaded handler
       (GCS.video.init()), same as every other module.
    ---------------------------------------------------------- */

    function init() {
        canvas = document.getElementById('cameraCanvas');
        ctx = canvas?.getContext('2d');
        videoEl = document.createElement('video');
        videoEl.muted = true;
        videoEl.playsInline = true;

        document.getElementById('camera-start-btn')?.addEventListener('click', startStream);
        document.getElementById('camera-stop-btn')?.addEventListener('click', stopStream);
        document.getElementById('camera-select')?.addEventListener('change', onCameraSelected);

        if (navigator.mediaDevices?.addEventListener) {
            navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
        }

        listCameras();
        setNoSignal('NO SIGNAL');
        setCameraName(null);

        document.addEventListener('gcs:update', onUpdate);
    }

    GCS.video = { init, startStream, stopStream };

})(window.GCS);
