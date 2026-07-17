/* ==========================================================
   ORIENTATION.JS
   3D attitude visualization (roll / pitch / yaw) built with
   Three.js. A CanSat model sits at the origin above a static
   world-reference floor grid + compass ring; the model's
   quaternion is driven by telemetry ('gcs:update') while the
   digital readouts (roll/pitch/yaw/heading) keep the same DOM
   ids the rest of the app already expects.

   Body-axes convention (standard aerospace / Tait-Bryan):
     - Yaw   → rotation about world-up   (Y axis)
     - Pitch → rotation about body-right (X axis)
     - Roll  → rotation about body-nose  (Z axis, model points -Z)
   Applied in Euler order 'YXZ' (yaw, then pitch, then roll),
   which is the conventional intrinsic aircraft rotation order.

   The camera can be orbited by dragging with the mouse/touch;
   telemetry keeps driving the model regardless of camera angle.
========================================================== */

window.GCS = window.GCS || {};

(function (GCS) {

    'use strict';

    /* ----------------------------------------------------------
       MODULE STATE
    ---------------------------------------------------------- */

    let scene, camera, renderer, container;
    let cansatGroup, targetQuat = new THREE.Quaternion();
    let compassRing;
    let rafId = null;
    let noSignalEl = null;

    // Orbit-camera state (spherical coords around the origin)
    const orbit = { radius: 9, theta: Math.PI / 4, phi: Math.PI / 2.6 };
    let dragging = false;
    let lastPointer = { x: 0, y: 0 };

    const COMPASS = ['North', 'North-East', 'East', 'South-East', 'South', 'South-West', 'West', 'North-West'];

    function headingName(yaw) {
        const idx = Math.round(yaw / 45) % 8;
        return COMPASS[idx];
    }

    /* ----------------------------------------------------------
       SCENE SETUP
    ---------------------------------------------------------- */

    function buildLights() {
        const ambient = new THREE.AmbientLight(0x8ea3c7, 0.65);
        scene.add(ambient);

        const key = new THREE.DirectionalLight(0xffffff, 1.0);
        key.position.set(5, 8, 4);
        scene.add(key);

        const rim = new THREE.DirectionalLight(0x4fc3f7, 0.35);
        rim.position.set(-6, 3, -4);
        scene.add(rim);
    }

    // Small canvas-texture label sprite (used for the N/E/S/W compass tags)
    function makeLabelSprite(text, color) {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.font = '600 34px "IBM Plex Mono", monospace';
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 64, 34);

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
        const sprite = new THREE.Sprite(material);
        sprite.scale.set(1.4, 0.7, 1);
        return sprite;
    }

    function buildFloor() {
        const group = new THREE.Group();

        const grid = new THREE.GridHelper(14, 14, 0x2c4568, 0x1c2a3f);
        grid.position.y = -1.6;
        group.add(grid);

        const diskGeo = new THREE.CircleGeometry(7, 64);
        const diskMat = new THREE.MeshBasicMaterial({ color: 0x070b13, transparent: true, opacity: 0.55 });
        const disk = new THREE.Mesh(diskGeo, diskMat);
        disk.rotation.x = -Math.PI / 2;
        disk.position.y = -1.61;
        group.add(disk);

        // compass ring — stays fixed to the world so it reads as
        // "true" heading while the CanSat model yaws against it
        compassRing = new THREE.Group();
        const dirs = [
            ['N', 0, '#4FC3F7'], ['E', -Math.PI / 2, '#7C8FAE'],
            ['S', Math.PI, '#7C8FAE'], ['W', Math.PI / 2, '#7C8FAE']
        ];
        dirs.forEach(([label, angle, color]) => {
            const sprite = makeLabelSprite(label, color);
            const r = 6.3;
            sprite.position.set(Math.sin(angle) * r, -1.3, -Math.cos(angle) * r);
            compassRing.add(sprite);
        });
        group.add(compassRing);

        scene.add(group);
    }

    // The CanSat/rocket model: body cylinder, nose cone, roll-index
    // stripe, and tail fins. Local +Y is "up/nose" before the group
    // is rotated to point along world -Z (forward) at rest.
    function buildCansat() {
        cansatGroup = new THREE.Group();

        const bodyMat = new THREE.MeshStandardMaterial({ color: 0x7c8fae, metalness: 0.35, roughness: 0.45 });
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 2.6, 24), bodyMat);
        cansatGroup.add(body);

        const noseMat = new THREE.MeshStandardMaterial({ color: 0xffb74d, metalness: 0.2, roughness: 0.4 });
        const nose = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.1, 24), noseMat);
        nose.position.y = 1.85;
        cansatGroup.add(nose);

        // roll-reference stripe — a thin red bar running the body
        // length so rotation about the nose axis is easy to read
        const stripeMat = new THREE.MeshStandardMaterial({ color: 0xff5252, metalness: 0.1, roughness: 0.5 });
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.6, 0.06), stripeMat);
        stripe.position.set(0, 0, 0.56);
        cansatGroup.add(stripe);

        // four tail fins near the base
        const finMat = new THREE.MeshStandardMaterial({ color: 0x4ade80, metalness: 0.15, roughness: 0.5 });
        for (let i = 0; i < 4; i++) {
            const fin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.9, 0.75), finMat);
            fin.position.y = -1.15;
            const angle = (Math.PI / 2) * i;
            fin.position.x = Math.sin(angle) * 0.55;
            fin.position.z = Math.cos(angle) * 0.55;
            fin.rotation.y = angle;
            cansatGroup.add(fin);
        }

        // whip antenna — thin tapered rod angled off the shoulder of
        // the body, near the nose cone base
        const antennaMat = new THREE.MeshStandardMaterial({ color: 0xc9d6e8, metalness: 0.6, roughness: 0.3 });
        const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.035, 1.5, 8), antennaMat);
        antenna.position.set(0.42, 1.15, 0.2);
        antenna.rotation.z = THREE.MathUtils.degToRad(-28);
        antenna.rotation.x = THREE.MathUtils.degToRad(12);
        cansatGroup.add(antenna);

        // small antenna base collar where the whip meets the body
        const collarMat = new THREE.MeshStandardMaterial({ color: 0x2c4568, metalness: 0.4, roughness: 0.5 });
        const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.08, 12), collarMat);
        collar.position.set(0.34, 0.98, 0.18);
        collar.rotation.z = THREE.MathUtils.degToRad(-28);
        cansatGroup.add(collar);

        // parachute mount — a raised ring + eyelet at the very top of
        // the nose where the shroud lines/riser would attach
        const mountMat = new THREE.MeshStandardMaterial({ color: 0xe0e6f0, metalness: 0.5, roughness: 0.35 });
        const mountRing = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.035, 10, 20), mountMat);
        mountRing.position.y = 2.42;
        mountRing.rotation.x = Math.PI / 2;
        cansatGroup.add(mountRing);

        const mountStem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.22, 12), mountMat);
        mountStem.position.y = 2.3;
        cansatGroup.add(mountStem);

        // faint body-axes helper for orientation reference
        const axes = new THREE.AxesHelper(1.6);
        axes.material.transparent = true;
        axes.material.opacity = 0.5;
        cansatGroup.add(axes);

        // The body was authored standing "up" along +Y with the nose
        // pointing +Y. Rotate the whole group so its nose points along
        // -Z at rest, matching the aerospace body-axes convention used
        // by applyOrientation() (nose = -Z, right = +X, up (body) = +Y).
        cansatGroup.rotation.x = Math.PI / 2;

        scene.add(cansatGroup);
    }

    function positionCamera() {
        camera.position.set(
            orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta),
            orbit.radius * Math.cos(orbit.phi),
            orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta)
        );
        camera.lookAt(0, 0, 0);
    }

    /* ----------------------------------------------------------
       ORBIT DRAG INTERACTION
    ---------------------------------------------------------- */

    function onPointerDown(e) {
        dragging = true;
        const p = e.touches ? e.touches[0] : e;
        lastPointer = { x: p.clientX, y: p.clientY };
    }

    function onPointerMove(e) {
        if (!dragging) return;
        const p = e.touches ? e.touches[0] : e;
        const dx = p.clientX - lastPointer.x;
        const dy = p.clientY - lastPointer.y;
        lastPointer = { x: p.clientX, y: p.clientY };

        orbit.theta -= dx * 0.006;
        orbit.phi = Math.min(Math.PI - 0.15, Math.max(0.15, orbit.phi - dy * 0.006));
        positionCamera();
    }

    function onPointerUp() { dragging = false; }

    function bindOrbitControls() {
        container.addEventListener('mousedown', onPointerDown);
        window.addEventListener('mousemove', onPointerMove);
        window.addEventListener('mouseup', onPointerUp);

        container.addEventListener('touchstart', onPointerDown, { passive: true });
        window.addEventListener('touchmove', onPointerMove, { passive: true });
        window.addEventListener('touchend', onPointerUp);

        container.style.cursor = 'grab';
        container.addEventListener('mousedown', () => container.style.cursor = 'grabbing');
        window.addEventListener('mouseup', () => container.style.cursor = 'grab');
    }

    /* ----------------------------------------------------------
       TELEMETRY → ROTATION
    ---------------------------------------------------------- */

    function applyOrientation(o) {
        const rollRad = THREE.MathUtils.degToRad(o.roll);
        const pitchRad = THREE.MathUtils.degToRad(o.pitch);
        const yawRad = THREE.MathUtils.degToRad(o.yaw);

        const euler = new THREE.Euler(pitchRad, yawRad, -rollRad, 'YXZ');
        targetQuat.setFromEuler(euler);
    }

    function updateReadouts(o) {
        GCS.util.setText('roll', (o.roll >= 0 ? '+' : '') + o.roll.toFixed(1) + '°');
        GCS.util.setText('pitch', (o.pitch >= 0 ? '+' : '') + o.pitch.toFixed(1) + '°');
        GCS.util.setText('yaw', String(Math.round(o.yaw)).padStart(3, '0') + '°');
        GCS.util.setText('heading', headingName(o.yaw));
    }

    function setNoTelemetry(show) {
        if (!noSignalEl) return;
        noSignalEl.classList.toggle('show', show);
    }

    function onUpdate(e) {
        const state = e.detail;
        const o = state.orientation;

        // Disconnected / stopped: freeze the model at its last known
        // attitude, show the overlay, but keep the scene itself stable
        // (still rendering, camera still orbit-able) rather than blanking it.
        if (!state.running || state.connection === 'disconnected') {
            setNoTelemetry(true);
            return;
        }

        setNoTelemetry(false);
        applyOrientation(o);
        updateReadouts(o);
    }

    /* ----------------------------------------------------------
       RENDER LOOP
       Smoothly slerps the model toward the latest telemetry
       quaternion so ~1 Hz packets still look fluid on screen.
    ---------------------------------------------------------- */

    function animate() {
        rafId = requestAnimationFrame(animate);
        if (cansatGroup) {
            cansatGroup.quaternion.slerp(targetQuat, 0.12);
        }
        renderer.render(scene, camera);
    }

    /* ----------------------------------------------------------
       RESIZE
    ---------------------------------------------------------- */

    function resize() {
        if (!container || !renderer || !camera) return;
        const w = container.clientWidth || 1;
        const h = container.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }

    /* ----------------------------------------------------------
       INIT
       Called once from app.js's DOMContentLoaded handler
       (GCS.orientation.init()), same as every other module.
    ---------------------------------------------------------- */

    function init() {
        container = document.getElementById('orientation3d');
        if (!container || typeof THREE === 'undefined') return;

        noSignalEl = document.getElementById('orientation-nosignal');
        setNoTelemetry(true); // no packets received yet at startup

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x070b13);
        scene.fog = new THREE.Fog(0x070b13, 10, 20);

        camera = new THREE.PerspectiveCamera(42, (container.clientWidth || 1) / (container.clientHeight || 1), 0.1, 100);
        positionCamera();

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        container.appendChild(renderer.domElement);

        buildLights();
        buildFloor();
        buildCansat();
        bindOrbitControls();

        resize();
        window.addEventListener('resize', resize);
        if (window.ResizeObserver) {
            new ResizeObserver(resize).observe(container);
        }

        document.addEventListener('gcs:update', onUpdate);

        animate();
    }

    GCS.orientation = { init };

})(window.GCS);
