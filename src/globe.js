import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import gsap from 'gsap'

const ACCENT = new THREE.Color('#ff8a3c')
const ACCENT_DIM = new THREE.Color('#b35a24')
const HOME = new THREE.Color('#59d9ff')
const ACTIVE = new THREE.Color('#ffffff')

// pins/arcs float just above the model's highest terrain
const SURF = 1.012

let _dotTex = null
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

    this._loop = this._loop.bind(this)
    this._raf = requestAnimationFrame(this._loop)
  }

  _initScene() {
    const { clientWidth: w, clientHeight: h } = this.container
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.01, 200)
    this.camera.position.copy(latLonToVec3(this.view.lat, this.view.lon, this.view.dist))
    this.camera.lookAt(0, 0, 0)

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(w, h)
    this.container.appendChild(this.renderer.domElement)

    // bright, even illumination so the 4K texture reads crisp everywhere
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85))
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.25)
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
    this.controls.minDistance = 1.18
    this.controls.maxDistance = 4.5
    this.controls.autoRotate = false
    this.controls.autoRotateSpeed = 0.35

    this._resize = () => {
      const { clientWidth, clientHeight } = this.container
      this.camera.aspect = clientWidth / clientHeight
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(clientWidth, clientHeight)
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

    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(1, 64, 64),
      new THREE.ShaderMaterial({
        vertexShader: `
          varying vec3 vNormal;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          varying vec3 vNormal;
          void main() {
            float intensity = pow(0.52 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 5.0);
            gl_FragColor = vec4(0.35, 0.6, 1.0, 1.0) * intensity * 0.85;
          }`,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
      })
    )
    atmo.scale.setScalar(1.12)
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

  flyTo(trip, dist = 1.5) {
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
      // camera from scroll state + a gentle drift toward the cursor
      const lat = this.view.lat - this._par.y * 2.4
      const lon = this.view.lon + this._par.x * 3.2
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

    // keep pins near-constant screen size across zoom, pulse rings
    const alt = this.camera.position.length() - 1
    const ps = THREE.MathUtils.clamp(alt * 1.05, 0.55, 1.9)
    for (const pin of this.pins) {
      const pulse = pin._active
        ? 1.3 + Math.sin(t * 3.2) * 0.25
        : 1 + Math.sin(t * 2 + pin.trip.lat) * 0.12
      const a = pin._a
      pin.ring.scale.setScalar(Math.max(ps * pulse * a, 0.0001))
      pin.dot.scale.setScalar(Math.max(ps * (pin._active ? 1.4 : 1) * a, 0.0001))
      pin.ring.visible = a > 0.02
      pin.dot.visible = a > 0.02
    }
    for (const hit of this.hitMeshes) hit.scale.setScalar(Math.max(ps, 0.8))

    for (const s of this.starGroups) {
      s.rotation.y += s.userData.spin
    }
    if (this.clouds) this.clouds.rotation.y += 0.00016
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
