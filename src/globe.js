import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import gsap from 'gsap'

const ACCENT = new THREE.Color('#ff8a3c')
const ACCENT_DIM = new THREE.Color('#b35a24')
const HOME = new THREE.Color('#59d9ff')
const ACTIVE = new THREE.Color('#ffffff')

// pins/arcs float just above the model's highest terrain
const SURF = 1.012

let _dotTex = null
// Radial falloff so a detail patch dissolves into the globe at its rim instead
// of ending in a hard square edge. One canvas, shared by every patch.
let _featherTex = null
function featherTexture() {
  if (_featherTex) return _featherTex
  const size = 256
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size, size)
  // blurred inset rect: opaque across the middle, soft only at the rim, so the
  // patch keeps its full frame instead of being cropped to a circle
  const inset = size * 0.1
  ctx.filter = `blur(${size * 0.055}px)`
  ctx.fillStyle = '#fff'
  ctx.fillRect(inset, inset, size - inset * 2, size - inset * 2)
  ctx.filter = 'none'
  _featherTex = new THREE.CanvasTexture(c)
  return _featherTex
}

function roundDotTexture() {
  if (_dotTex) return _dotTex
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.6, 'rgba(255,255,255,0.85)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.beginPath()
  g.arc(32, 32, 32, 0, Math.PI * 2)
  g.fill()
  _dotTex = new THREE.CanvasTexture(c)
  return _dotTex
}

export function latLonToVec3(lat, lon, r = 1) {
  const phi = THREE.MathUtils.degToRad(90 - lat)
  const theta = THREE.MathUtils.degToRad(lon)
  return new THREE.Vector3(
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    -r * Math.sin(phi) * Math.sin(theta)
  )
}

export class TravelGlobe {
  constructor(container, { trips, route, onPinClick, onPinHover }) {
    this.container = container
    this.trips = trips
    this.route = route
    this.onPinClick = onPinClick
    this.onPinHover = onPinHover

    // camera view driven by the scroll triggers (lat/lon/dist + look target,
    // so flight legs can gaze ahead over the terrain instead of straight down)
    this.view = { lat: 45, lon: 10, dist: 3.6, lx: 0, ly: 0, lz: 0 }
    this.explore = false
    this.activeId = null
    this._routeProgress = 0
    this._hovered = null
    this._pointer = new THREE.Vector2(-2, -2)
    this._pointerPx = { x: 0, y: 0 }
    this._needsRaycast = false
    this._clock = new THREE.Clock()
    // cursor-follow parallax (target ↔ smoothed)
    this._par = { x: 0, y: 0, tx: 0, ty: 0 }

    this._initScene()
    this._buildAtmosphere()
    this._buildPins()
    this._buildArcs()
    this._buildStars()
    this._bindEvents()
    this._loadEarth()
    this._initDetail()
    this._initOutlines()

    this._loop = this._loop.bind(this)
    this._raf = requestAnimationFrame(this._loop)
  }

  _initScene() {
    const { clientWidth: w, clientHeight: h } = this.container
    this.scene = new THREE.Scene()
    // near must be tiny to descend to ~25 km altitude without clipping the
    // surface; the resulting near/far ratio needs the log depth buffer below
    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.0002, 300)
    this.camera.position.copy(latLonToVec3(this.view.lat, this.view.lon, this.view.dist))
    this.camera.lookAt(0, 0, 0)

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      // near/far spans ~1e6 so a normal depth buffer z-fights badly
      logarithmicDepthBuffer: true,
      // lets toDataURL read real frames back for visual checks; dev only, it
      // costs performance on some GPUs
      preserveDrawingBuffer: import.meta.env.DEV,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(w, h)
    this.container.appendChild(this.renderer.domElement)

    // bright, even illumination so the 4K texture reads crisp everywhere
    this._amb = new THREE.AmbientLight(0xffffff, 0.85)
    this.scene.add(this._amb)
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.25)
    this._sun = sun
    sun.position.set(3, 2.2, 3.5)
    this.scene.add(sun)
    const rim = new THREE.DirectionalLight(0x6a8fff, 0.25)
    rim.position.set(-4, -1, -3)
    this.scene.add(rim)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enabled = false
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.06
    this.controls.enablePan = false
    this.controls.minDistance = 1.004   // ~25 km altitude
    this.controls.maxDistance = 14      // stars start at r16 — stay inside them
    // default steps are far too coarse across a 1.004..14 range
    this.controls.zoomSpeed = 0.75
    this.controls.zoomToCursor = true
    this.controls.autoRotate = false
    this.controls.autoRotateSpeed = 0.35

    this._resize = () => {
      const { clientWidth, clientHeight } = this.container
      this.camera.aspect = clientWidth / clientHeight
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(clientWidth, clientHeight)
      // fat lines need pixel resolution to size their width
      if (this.outlines) {
        for (const e of this.outlines.values()) {
          for (const { line } of e.lines) line.material.resolution.set(clientWidth, clientHeight)
        }
      }
    }
    window.addEventListener('resize', this._resize)
  }

  _buildAtmosphere() {
    // placeholder ocean sphere shown until the model streams in
    this.placeholder = new THREE.Mesh(
      new THREE.SphereGeometry(0.985, 48, 48),
      new THREE.MeshPhongMaterial({ color: 0x0d3766, shininess: 20 })
    )
    this.scene.add(this.placeholder)

    // Rim glow. This is a BackSide shell at r1.12, so any camera closer than
    // that ends up *inside* it and renders its interior over the whole frame —
    // the old minDistance of 1.18 was what kept us out. Now that the camera can
    // reach r1.004, uOpacity fades the shell out before we cross it.
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(1, 64, 64),
      new THREE.ShaderMaterial({
        uniforms: { uOpacity: { value: 1 } },
        vertexShader: `
          varying vec3 vNormal;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform float uOpacity;
          varying vec3 vNormal;
          void main() {
            // unclamped this exceeds 1.0 at grazing angles and clips to white
            float intensity = clamp(
              pow(0.52 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 5.0), 0.0, 1.0);
            gl_FragColor = vec4(0.35, 0.6, 1.0, 1.0) * intensity * 0.85 * uOpacity;
          }`,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
      })
    )
    atmo.scale.setScalar(1.12)
    this.atmo = atmo
    this.scene.add(atmo)
  }

  async _loadEarth() {
    try {
      const tl = new THREE.TextureLoader()
      const base = import.meta.env.BASE_URL
      const [map, bump, spec, cloudsMap] = await Promise.all([
        tl.loadAsync(`${base}earth/earth-blue-marble.jpg`),
        tl.loadAsync(`${base}earth/earth-topology.png`),
        tl.loadAsync(`${base}earth/earth-water.png`),
        tl.loadAsync(`${base}earth/clouds.png`),
      ])
      const aniso = this.renderer.capabilities.getMaxAnisotropy()
      map.colorSpace = THREE.SRGBColorSpace
      map.anisotropy = aniso
      bump.anisotropy = aniso

      this.earth = new THREE.Mesh(
        new THREE.SphereGeometry(1, 128, 128),
        new THREE.MeshPhongMaterial({
          map,
          bumpMap: bump,
          bumpScale: 0.045,
          specularMap: spec,
          specular: new THREE.Color(0x33517a),
          shininess: 16,
        })
      )
      this.scene.add(this.earth)

      // drifting cloud layer just above the surface
      this.clouds = new THREE.Mesh(
        new THREE.SphereGeometry(1.005, 96, 96),
        new THREE.MeshLambertMaterial({
          map: cloudsMap,
          transparent: true,
          opacity: 0.34,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      )
      this.scene.add(this.clouds)

      this.scene.remove(this.placeholder)
      this.placeholder.geometry.dispose()
      this.placeholder.material.dispose()
      this.placeholder = null
    } catch (e) {
      console.warn('earth textures failed to load, keeping placeholder', e)
    }
  }

  // ---- high-resolution pin imagery -------------------------------------
  // The global Blue Marble texture is ~9.8 km/px, so descending into a city
  // just magnifies blur. Each pin has a pre-baked Sentinel-2 crop (~14 m/px)
  // that fades in as the camera drops, laid on a curved patch that hugs the
  // sphere so it can't z-fight the surface underneath.
  async _initDetail() {
    this.detail = new Map()
    this._detailMeta = null
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}earth/detail/index.json`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      this._detailMeta = new Map(json.patches.map((p) => [p.id, p]))
    } catch (e) {
      // no imagery baked yet — the globe just keeps its global texture
      console.warn('pin imagery index unavailable, skipping detail patches', e)
    }
  }

  // Build the patch + kick off its texture. Safe to call repeatedly.
  _ensureDetail(id) {
    if (!this._detailMeta || this.detail.has(id)) return this.detail.get(id)
    const m = this._detailMeta.get(id)
    if (!m) return null

    // Three's sphere: phi is azimuth, theta polar from +Y. This globe places
    // points at phi = lon + PI, theta = 90 - lat (see latLonToVec3).
    const d2r = THREE.MathUtils.degToRad
    const thetaStart = d2r(90 - m.north)
    const thetaLength = d2r(m.north - m.south)
    const phiStart = d2r(m.west) + Math.PI
    const phiLength = d2r(m.east - m.west)

    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.0006, 48, 48, phiStart, phiLength, thetaStart, thetaLength),
      // Unlit on purpose. Phong left the imagery at the mercy of the sun's angle,
      // and half the pins sat in shade — the whole point is to see the place.
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        alphaMap: featherTexture(),
      })
    )
    mesh.visible = false
    mesh.renderOrder = 2
    this.scene.add(mesh)

    const entry = { mesh, meta: m, opacity: 0, center: latLonToVec3(m.lat, m.lon, 1) }
    this.detail.set(id, entry)

    new THREE.TextureLoader().load(
      `${import.meta.env.BASE_URL}earth/detail/${id}.jpg`,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
        mesh.material.map = tex
        mesh.material.needsUpdate = true
        entry.ready = true
      },
      undefined,
      () => {
        // texture missing: drop the patch so we fall back to the globe texture
        this.scene.remove(mesh)
        mesh.geometry.dispose()
        mesh.material.dispose()
        this.detail.delete(id)
      }
    )
    return entry
  }

  _updateDetail() {
    if (!this._detailMeta) return 0
    const camDir = this.camera.position.clone().normalize()
    const alt = this.camera.position.length() - 1

    // start fetching a little before the imagery is needed so it has time to
    // decode; below ~0.012 (75 km) it is fully opaque
    // Fade on how much of the frame the crop actually covers, not on raw
    // altitude. Crops run 9 km to 35 km and each trip now settles at its own
    // distance, so a fixed altitude band would leave the big ones half faded.
    const visible = 2 * alt * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    const winnerMeta = this._detailMeta.get(this.activeId) || null
    const spanRad = winnerMeta ? ((winnerMeta.east - winnerMeta.west) * Math.PI) / 180 : 0.003
    const altFade = THREE.MathUtils.smoothstep(spanRad / Math.max(visible, 1e-6), 0.5, 0.85)

    // Prefetch generously — neighbours loading early is good. Only ever SHOW
    // one, though: Florence, Tuscany and Spring Break sit 0.25 degrees apart,
    // so a proximity test alone lights three patches at once and they read as
    // squares pasted on the globe.
    if (altFade > 0.001 || alt < 0.02) {
      for (const [id, m] of this._detailMeta) {
        if (camDir.dot(latLonToVec3(m.lat, m.lon, 1)) > 0.9985) this._ensureDetail(id)
      }
    }

    // scroll mode follows the active section; explore mode takes whichever
    // patch the camera is most directly above
    let winner = null
    if (!this.explore && this.activeId && this.detail.has(this.activeId)) {
      winner = this.activeId
    } else {
      let best = 0.999
      for (const [id, entry] of this.detail) {
        const d = camDir.dot(entry.center)
        if (d > best) {
          best = d
          winner = id
        }
      }
    }

    for (const [id, entry] of this.detail) {
      const target = entry.ready && id === winner ? altFade : 0
      entry.opacity += (target - entry.opacity) * 0.12
      entry.mesh.material.opacity = entry.opacity
      entry.mesh.visible = entry.opacity > 0.004
      entry.mesh.material.needsUpdate = false
    }
    return altFade
  }

  // ---- arrival sequence ------------------------------------------------
  // Landing on a flat satellite crop is inert, so the city announces itself:
  // its real OSM boundary traces around the perimeter, then the ground outside
  // that boundary dims so the place reads as a place. Trips whose pin isn't a
  // city (the Sahara; Pisa's comune is far larger than the crop) have no
  // boundary and get an expanding reticle instead — never an invented outline.
  async _initOutlines() {
    this.outlines = new Map()
    this._outlineMeta = null
    this._arrival = null
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}earth/detail/outlines.json`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      this._outlineMeta = new Map(json.outlines.map((o) => [o.id, o]))
    } catch (e) {
      console.warn('city outlines unavailable', e)
    }
  }

  _ensureOutline(id) {
    if (!this._outlineMeta || this.outlines.has(id)) return this.outlines.get(id)
    const meta = this._outlineMeta.get(id)
    const patch = this._detailMeta?.get(id)
    if (!meta || !patch) return null

    const trip = this.trips.find((t) => t.id === id)
    const color = new THREE.Color(trip?.color || ACCENT)
    const entry = { id, hasOutline: meta.hasOutline, lines: [], total: 0, a: 0 }

    if (meta.hasOutline) {
      for (const ring of meta.rings) {
        const pts = ring.map(([lon, lat]) => latLonToVec3(lat, lon, 1.0011))
        pts.push(pts[0].clone())
        const flat = []
        for (const v of pts) flat.push(v.x, v.y, v.z)
        const geo = new LineGeometry()
        geo.setPositions(flat)
        // total arc length drives the dash-based draw-on below
        let len = 0
        for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1])
        const mat = new LineMaterial({
          color: color.getHex(),
          linewidth: 2.4,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          dashed: true,
          dashSize: len,
          gapSize: len,
          dashOffset: len,
        })
        mat.resolution.set(this.container.clientWidth || 1, this.container.clientHeight || 1)
        const line = new Line2(geo, mat)
        line.computeLineDistances()
        line.renderOrder = 5
        line.visible = false
        this.scene.add(line)
        entry.lines.push({ line, len })
      }

      // Dim everything outside the boundary: a quad over the patch footprint
      // with the city punched out as a hole, so the city stays lit.
      // pad far beyond the imagery: a quad sized to the crop shows its own
      // straight edges as seams once it dims
      const padX = (patch.east - patch.west) * 2.5
      const padY = (patch.north - patch.south) * 2.5
      const shape = new THREE.Shape([
        new THREE.Vector2(patch.west - padX, patch.south - padY),
        new THREE.Vector2(patch.east + padX, patch.south - padY),
        new THREE.Vector2(patch.east + padX, patch.north + padY),
        new THREE.Vector2(patch.west - padX, patch.north + padY),
      ])
      for (const ring of meta.rings) {
        shape.holes.push(new THREE.Path(ring.map(([lon, lat]) => new THREE.Vector2(lon, lat))))
      }
      const shapeGeo = new THREE.ShapeGeometry(shape)
      // ShapeGeometry lays out flat in lon/lat; lift each vertex onto the sphere
      const pos = shapeGeo.attributes.position
      for (let i = 0; i < pos.count; i++) {
        const v = latLonToVec3(pos.getY(i), pos.getX(i), 1.0008)
        pos.setXYZ(i, v.x, v.y, v.z)
      }
      pos.needsUpdate = true
      shapeGeo.computeVertexNormals()
      const dim = new THREE.Mesh(
        shapeGeo,
        new THREE.MeshBasicMaterial({
          color: 0x03060f,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        })
      )
      dim.renderOrder = 4
      dim.visible = false
      this.scene.add(dim)
      entry.dim = dim
    } else {
      // no real boundary — a reticle marks the spot without claiming a shape
      const m = this._detailMeta.get(id)
      // size to the crop — a fixed radius was a 24 km ring inside an 18 km frame
      const halfSpan = ((m.east - m.west) * Math.PI) / 360
      const r = Math.max(halfSpan * 0.11, 0.00012)
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(r, r * 1.07, 72),
        new THREE.MeshBasicMaterial({
          color: color.clone(),
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      )
      const at = latLonToVec3(m.lat, m.lon, 1.0011)
      ring.position.copy(at)
      ring.lookAt(at.clone().multiplyScalar(2))
      ring.renderOrder = 5
      ring.visible = false
      this.scene.add(ring)
      entry.reticle = ring
    }

    this.outlines.set(id, entry)
    return entry
  }

  // called from the per-section ScrollTrigger so the boundary traces on as the
  // section scrolls into view
  setArrivalProgress(id, p) {
    this._scrollP = { id, p }
  }

  _updateArrival(t, altFade) {
    if (!this._outlineMeta) return
    const active = !this.explore && this.activeId ? this.activeId : null
    if (active && (!this._arrival || this._arrival.id !== active)) {
      this._ensureOutline(active)
      this._arrival = { id: active, start: t }
    }

    for (const [id, e] of this.outlines) {
      const on = this._arrival && this._arrival.id === id ? 1 : 0
      // gate on altFade so nothing shows while the imagery is still hidden
      const target = on * altFade
      e.a += (target - e.a) * 0.09

      // Scroll drives the trace when there is scroll to read; explore mode has
      // none, so it falls back to a timed draw on arrival.
      const elapsed = this._arrival && this._arrival.id === id ? t - this._arrival.start : 0
      const scrolled = this._scrollP && this._scrollP.id === id ? this._scrollP.p : null
      const draw =
        scrolled != null && !this.explore
          ? THREE.MathUtils.clamp(scrolled / 0.55, 0, 1)
          : THREE.MathUtils.clamp(elapsed / 1.3, 0, 1)
      const eased = draw * draw * (3 - 2 * draw)

      for (const { line, len } of e.lines) {
        // dash pattern is one dash + one gap, each the full length, so sliding
        // the offset from len to 0 traces the boundary on
        line.material.dashOffset = len * (1 - eased)
        line.material.opacity = e.a
        line.visible = e.a > 0.01
      }
      if (e.dim) {
        // dim only once the line has closed, or it reads as a rendering fault
        const after =
          scrolled != null && !this.explore
            ? THREE.MathUtils.clamp((scrolled - 0.55) / 0.25, 0, 1)
            : THREE.MathUtils.clamp((elapsed - 1.3) / 0.7, 0, 1)
        e.dim.material.opacity = e.a * after * 0.38
        e.dim.visible = e.dim.material.opacity > 0.01
      }
      if (e.reticle) {
        const pulse = 1 + Math.sin(elapsed * 1.6) * 0.12
        e.reticle.scale.setScalar(pulse * (0.6 + eased * 0.4))
        e.reticle.material.opacity = e.a * 0.9
        e.reticle.visible = e.a > 0.01
      }
    }
  }

  _buildPins() {
    this.pins = []
    this.hitMeshes = []
    const dotGeo = new THREE.SphereGeometry(0.0048, 16, 16)
    const ringGeo = new THREE.RingGeometry(0.0088, 0.0115, 32)
    const hitGeo = new THREE.SphereGeometry(0.026, 8, 8)

    for (const trip of this.trips) {
      if (trip.noPin) continue
      const pos = latLonToVec3(trip.lat, trip.lon, SURF)
      const color = new THREE.Color(trip.color || (trip.home ? HOME : ACCENT))

      const dot = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: color.clone() }))
      dot.position.copy(pos)

      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          color: color.clone(),
          transparent: true,
          opacity: 0.85,
          side: THREE.DoubleSide,
        })
      )
      ring.position.copy(pos)
      ring.lookAt(pos.clone().multiplyScalar(2))

      const hit = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }))
      hit.position.copy(pos)
      hit.userData.trip = trip

      this.scene.add(dot, ring, hit)
      // pins start hidden and pop in as the journey reaches them
      const routeIdx = this.route.indexOf(trip)
      this.pins.push({
        trip,
        dot,
        ring,
        baseColor: color,
        dimColor: color.clone().multiplyScalar(0.55),
        routeIdx,
        appear: trip.home ? 1 : 0, // home base is lit from the start
      })
      this.hitMeshes.push(hit)
    }
  }

  _buildArcs() {
    this.arcs = []
    const N = 96
    for (let i = 0; i < this.route.length - 1; i++) {
      const a = latLonToVec3(this.route[i].lat, this.route[i].lon).normalize()
      const b = latLonToVec3(this.route[i + 1].lat, this.route[i + 1].lon).normalize()
      const angle = a.angleTo(b)
      const lift = 0.035 + angle * 0.32
      const sinA = Math.sin(angle)
      const pts = []
      for (let j = 0; j <= N; j++) {
        const t = j / N
        const p =
          angle < 1e-5
            ? a.clone()
            : a
                .clone()
                .multiplyScalar(Math.sin((1 - t) * angle) / sinA)
                .addScaledVector(b, Math.sin(t * angle) / sinA)
        p.normalize().multiplyScalar(SURF + Math.sin(Math.PI * t) * lift)
        pts.push(p)
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts)
      geo.setDrawRange(0, 0)
      // each leg glows in the color of its destination
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({
          color: new THREE.Color(this.route[i + 1].color || ACCENT),
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      )
      this.scene.add(line)
      this.arcs.push({ line, pts, count: N + 1 })
    }

    this.traveler = new THREE.Mesh(
      new THREE.SphereGeometry(0.006, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    )
    this.traveler.visible = false
    this.scene.add(this.traveler)
  }

  _buildStars() {
    // layered starfield: three depths/sizes + a few warm giants
    this.starGroups = []
    const layers = [
      { count: 2600, size: 0.04, color: 0x9fb2d8, opacity: 0.55, spin: 0.00012 },
      { count: 900, size: 0.08, color: 0xdde6ff, opacity: 0.8, spin: 0.00018 },
      { count: 140, size: 0.16, color: 0xffd9a8, opacity: 0.9, spin: 0.00026 },
    ]
    for (const l of layers) {
      const posArr = new Float32Array(l.count * 3)
      for (let i = 0; i < l.count; i++) {
        const vec = new THREE.Vector3()
          .randomDirection()
          .multiplyScalar(16 + Math.random() * 50)
        posArr.set([vec.x, vec.y, vec.z], i * 3)
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3))
      const pts = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          color: l.color,
          size: l.size,
          sizeAttenuation: true,
          map: roundDotTexture(),
          alphaTest: 0.15,
          transparent: true,
          opacity: l.opacity,
          depthWrite: false,
        })
      )
      pts.userData.spin = l.spin
      this.scene.add(pts)
      this.starGroups.push(pts)
    }
  }

  get routeProgress() {
    return this._routeProgress
  }

  set routeProgress(p) {
    this._routeProgress = p
    for (let i = 0; i < this.arcs.length; i++) {
      const f = THREE.MathUtils.clamp(p - i, 0, 1)
      this.arcs[i].line.geometry.setDrawRange(0, Math.ceil(f * this.arcs[i].count))
    }
    const idx = Math.min(Math.floor(p), this.arcs.length - 1)
    const arc = this.arcs[idx]
    if (arc && p > 0) {
      const f = THREE.MathUtils.clamp(p - idx, 0, 1)
      const pt = arc.pts[Math.min(Math.round(f * (arc.count - 1)), arc.count - 1)]
      this.traveler.position.copy(pt)
      this.traveler.visible = f > 0.005 && f < 0.995
    } else {
      this.traveler.visible = false
    }
  }

  setActive(tripId) {
    this.activeId = tripId
    for (const pin of this.pins) {
      const active = pin.trip.id === tripId
      pin.dot.material.color.copy(active ? ACTIVE : pin.dimColor)
      pin.ring.material.color.copy(active ? pin.baseColor : pin.dimColor)
      pin.ring.material.opacity = active ? 1 : 0.55
      pin._active = active
    }
  }

  setExplore(on) {
    this.explore = on
    this.controls.enabled = on
    this.controls.autoRotate = on
    if (on) {
      this.controls.target.set(0, 0, 0)
      this.controls.update()
      // glide out to a wide view so the whole route is on screen
      const t = latLonToVec3(this.view.lat, this.view.lon, Math.max(this.view.dist, 2.9))
      gsap.to(this.camera.position, {
        x: t.x,
        y: t.y,
        z: t.z,
        duration: 1.6,
        ease: 'power2.inOut',
        onUpdate: () => this.controls.update(),
      })
      // in explore mode every pin lights up in its own color
      for (const pin of this.pins) {
        pin.dot.material.color.copy(pin.baseColor)
        pin.ring.material.color.copy(pin.baseColor)
        pin.ring.material.opacity = 0.9
      }
    } else {
      this.setActive(this.activeId)
    }
  }

  flyTo(trip, dist = 1.05) {
    const target = latLonToVec3(trip.lat, trip.lon, dist)
    this.controls.autoRotate = false
    gsap.to(this.camera.position, {
      x: target.x,
      y: target.y,
      z: target.z,
      duration: 1.4,
      ease: 'power2.inOut',
      onUpdate: () => this.controls.update(),
    })
  }

  _bindEvents() {
    const el = this.renderer.domElement
    this._onMove = (e) => {
      const r = el.getBoundingClientRect()
      this._pointer.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1
      )
      this._pointerPx = { x: e.clientX, y: e.clientY }
      this._needsRaycast = true
    }
    this._onDown = (e) => {
      this._downAt = { x: e.clientX, y: e.clientY }
    }
    this._onUp = (e) => {
      if (!this._downAt) return
      const dx = e.clientX - this._downAt.x
      const dy = e.clientY - this._downAt.y
      if (dx * dx + dy * dy < 36 && this._hovered && this.onPinClick) {
        this.onPinClick(this._hovered)
      }
      this._downAt = null
    }
    el.addEventListener('pointermove', this._onMove)
    el.addEventListener('pointerdown', this._onDown)
    el.addEventListener('pointerup', this._onUp)

    // whole-window cursor tracking for the parallax drift
    this._onWindowMove = (e) => {
      this._par.tx = (e.clientX / window.innerWidth) * 2 - 1
      this._par.ty = (e.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener('pointermove', this._onWindowMove)
    this._raycaster = new THREE.Raycaster()
  }

  _raycast() {
    this._raycaster.setFromCamera(this._pointer, this.camera)
    const hits = this._raycaster.intersectObjects(this.hitMeshes, false)
    let trip = hits.length ? hits[0].object.userData.trip : null
    // ignore pins that haven't appeared yet
    if (trip) {
      const pin = this.pins.find((p) => p.trip === trip)
      if (pin && pin.appear < 0.5) trip = null
    }
    if (trip !== this._hovered) {
      this._hovered = trip
      this.renderer.domElement.style.cursor = trip ? 'pointer' : 'grab'
      if (this.onPinHover) {
        this.onPinHover(trip, this._pointerPx.x, this._pointerPx.y)
      }
    } else if (trip && this.onPinHover) {
      this.onPinHover(trip, this._pointerPx.x, this._pointerPx.y)
    }
  }

  _loop() {
    this._raf = requestAnimationFrame(this._loop)
    const t = this._clock.getElapsedTime()

    // smooth the cursor-follow parallax
    this._par.x += (this._par.tx - this._par.x) * 0.045
    this._par.y += (this._par.ty - this._par.y) * 0.045

    if (this.explore) {
      this.controls.update()
      if (this._needsRaycast) {
        this._needsRaycast = false
        this._raycast()
      }
    } else {
      // Camera from scroll state + a gentle drift toward the cursor. The drift
      // has to scale with altitude: 2.4 degrees is a nudge from orbit but ~270 km
      // up close, which would sail straight off the pin's imagery patch.
      const drift = THREE.MathUtils.clamp((this.view.dist - 1) / 0.6, 0.04, 1)
      const lat = this.view.lat - this._par.y * 2.4 * drift
      const lon = this.view.lon + this._par.x * 3.2 * drift
      this.camera.position.copy(latLonToVec3(lat, lon, this.view.dist))
      this.camera.lookAt(this.view.lx, this.view.ly, this.view.lz)
    }

    // pins pop in as the route reaches them
    const rp = this._routeProgress
    for (const pin of this.pins) {
      const target =
        this.explore || pin.trip.home || rp >= Math.max(pin.routeIdx - 0.12, 0) ? 1 : 0
      pin.appear += (target - pin.appear) * 0.09
      const a = pin.appear < 0.001 ? 0 : pin.appear
      pin._a = a
    }

    // Pins belong to the explore map, where they are clickable. In the scroll
    // story each section already carries its own title, so a pin there is just a
    // dot sitting on top of the imagery. Arcs stay — they draw the route.
    const alt = this.camera.position.length() - 1
    const ps = THREE.MathUtils.clamp(alt * 1.05, 0.02, 1.9)
    for (const pin of this.pins) {
      const pulse = pin._active
        ? 1.3 + Math.sin(t * 3.2) * 0.25
        : 1 + Math.sin(t * 2 + pin.trip.lat) * 0.12
      const a = this.explore ? pin._a : 0
      pin.ring.scale.setScalar(Math.max(ps * pulse * a, 0.0001))
      pin.dot.scale.setScalar(Math.max(ps * (pin._active ? 1.4 : 1) * a, 0.0001))
      pin.ring.visible = a > 0.02
      pin.dot.visible = a > 0.02
    }
    // hit spheres stay live so explore-mode clicks still open a weekend
    for (const hit of this.hitMeshes) hit.scale.setScalar(Math.max(ps, 0.8))

    const _af = this._updateDetail()
    this._updateArrival(t, _af || 0)

    // Clouds and the rim glow are both wide-view dressing and share one band.
    // Clouds used to fade on the close-up curve, which left them at ~0.3 opacity
    // 400 km up — a 4096px texture magnified that far is a screen-sized smear,
    // not weather.
    const wide = THREE.MathUtils.smoothstep(this.camera.position.length(), 1.1, 1.25)
    if (this.atmo) {
      this.atmo.material.uniforms.uOpacity.value = wide
      this.atmo.visible = wide > 0.002
    }

    for (const s of this.starGroups) {
      s.rotation.y += s.userData.spin
    }
    if (this.clouds) {
      this.clouds.rotation.y += 0.00016
      this.clouds.material.opacity = 0.34 * wide
      this.clouds.visible = wide > 0.006
    }

    // Fade the world down on approach. The global texture is ~9.8 km/px, so up
    // close it is pure blur; unlighting it means there is nothing soft to look at
    // and the sharp city imagery is the only lit thing in frame.
    if (this.earth) {
      // Cross-fade against the patch, not against altitude. Keyed to altitude
      // these two curves left a dark gap mid-descent where the world had already
      // dimmed but the imagery had not yet arrived.
      const lit = 1 - 0.82 * (_af || 0)
      this.earth.material.color.setScalar(lit)
      if (this._sun) this._sun.intensity = 1.25 * lit
      if (this._amb) this._amb.intensity = 0.1 + 0.75 * lit
    }
    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    cancelAnimationFrame(this._raf)
    window.removeEventListener('resize', this._resize)
    window.removeEventListener('pointermove', this._onWindowMove)
    const el = this.renderer.domElement
    el.removeEventListener('pointermove', this._onMove)
    el.removeEventListener('pointerdown', this._onDown)
    el.removeEventListener('pointerup', this._onUp)
    this.controls.dispose()
    this.renderer.dispose()
    this.container.removeChild(el)
  }
}
