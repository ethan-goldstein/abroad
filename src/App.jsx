import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'
import { TravelGlobe, latLonToVec3 } from './globe.js'
import { META, TRIPS, ROUTE } from './data.js'

gsap.registerPlugin(ScrollTrigger)

const BASE = import.meta.env.BASE_URL

// custom cursor + DOM parallax: one rAF loop drives both.
// The cursor is a blend-difference disc (vertex3d style): it inverts
// whatever sits beneath it, trails the mouse with lag, grows over anything
// interactive, and shows a contextual label (DRAG / OPEN).
function FlowCursor({ label }) {
  const blendRef = useRef(null)
  const labelRef = useRef(null)

  useEffect(() => {
    const fine = window.matchMedia('(pointer: fine)').matches
    if (!fine) return
    const pos = { x: innerWidth / 2, y: innerHeight / 2 }
    const disc = { ...pos }
    const tag = { ...pos }
    const par = { x: 0, y: 0 }
    let raf

    const onMove = (e) => {
      pos.x = e.clientX
      pos.y = e.clientY
    }
    const onOver = (e) => {
      const interactive = !!e.target.closest('button, a, .rail-num')
      blendRef.current?.classList.toggle('hoverable', interactive)
    }
    const tick = () => {
      raf = requestAnimationFrame(tick)
      disc.x += (pos.x - disc.x) * 0.16
      disc.y += (pos.y - disc.y) * 0.16
      tag.x += (pos.x - tag.x) * 0.11
      tag.y += (pos.y - tag.y) * 0.11
      if (blendRef.current) {
        blendRef.current.style.transform = `translate3d(${disc.x}px, ${disc.y}px, 0) translate(-50%, -50%)`
      }
      if (labelRef.current) {
        labelRef.current.style.transform = `translate3d(${tag.x + 24}px, ${tag.y + 20}px, 0)`
      }
      // smoothed CSS vars for text/hero parallax drift
      const nx = (pos.x / innerWidth) * 2 - 1
      const ny = (pos.y / innerHeight) * 2 - 1
      par.x += (nx - par.x) * 0.05
      par.y += (ny - par.y) * 0.05
      document.documentElement.style.setProperty('--mx', par.x.toFixed(4))
      document.documentElement.style.setProperty('--my', par.y.toFixed(4))
    }
    window.addEventListener('pointermove', onMove)
    document.addEventListener('mouseover', onOver)
    document.documentElement.classList.add('has-flow-cursor')
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('mouseover', onOver)
      document.documentElement.classList.remove('has-flow-cursor')
    }
  }, [])

  return (
    <>
      <div ref={blendRef} className={`cursor-blend ${label ? 'big' : ''}`} />
      <span ref={labelRef} className="cursor-label">
        {label}
      </span>
    </>
  )
}

function Photo({ trip, className }) {
  const [err, setErr] = useState(false)
  if (err || !trip.photo) {
    return (
      <div className={`photo-fallback ${className || ''}`}>
        <span>{trip.title}</span>
        <em>{trip.place}</em>
      </div>
    )
  }
  return (
    <img
      className={className}
      src={`${BASE}photos/${trip.photo}`}
      alt={`${trip.title} — ${trip.place}`}
      loading="lazy"
      onError={() => setErr(true)}
    />
  )
}

export default function App() {
  const stageRef = useRef(null)
  const globeRef = useRef(null)
  const lenisRef = useRef(null)
  const [intro, setIntro] = useState(true)
  const [selected, setSelected] = useState(null)
  const [hover, setHover] = useState(null)
  const [explore, setExplore] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const exploreRef = useRef(false)

  useEffect(() => {
    const globe = new TravelGlobe(stageRef.current, {
      trips: TRIPS,
      route: ROUTE,
      onPinClick: (trip) => {
        setSelected(trip)
        globe.flyTo(trip)
      },
      onPinHover: (trip, x, y) => setHover(trip ? { trip, x, y } : null),
    })
    globeRef.current = globe
    window.__globe = globe

    const lenis = new Lenis({ lerp: 0.09 })
    lenis.on('scroll', ScrollTrigger.update)
    const tick = (time) => lenis.raf(time * 1000)
    gsap.ticker.add(tick)
    gsap.ticker.lagSmoothing(0)
    lenisRef.current = lenis
    window.__lenis = lenis

    const cam = globe.view // mutated by the scroll triggers; globe reads it every frame
    window.__ST = ScrollTrigger

    // camera keyframes: hero → each trip → pulled-back explore view
    const keys = [
      { lat: 45, lon: 10, dist: 3.6, route: 0 },
      ...TRIPS.map((t) => ({
        lat: t.lat,
        lon: t.lon,
        dist: t.zoom ?? 1.6,
        route: -1, // filled below
      })),
      { lat: 42, lon: 8, dist: 3.1, route: ROUTE.length - 1 },
    ]
    TRIPS.forEach((t, i) => {
      const idx = ROUTE.indexOf(t)
      keys[i + 1].route = idx >= 0 ? idx : keys[i].route
    })

    const ctx = gsap.context(() => {
      // ---- one scrubbed camera leg per section (robust to any card height) ----
      // Each leg is a low-altitude flight: skim across the terrain on a
      // great-circle path with the camera gazing AHEAD over the land toward
      // the destination, then settle onto the next city.
      const ease = gsap.parseEase('power2.inOut')
      const R2D = 180 / Math.PI
      const slerpDir = (a, b, t, angle, sinA) =>
        angle < 1e-4
          ? a.clone()
          : a
              .clone()
              .multiplyScalar(Math.sin((1 - t) * angle) / sinA)
              .addScaledVector(b, Math.sin(t * angle) / sinA)
              .normalize()
      const sections = [...gsap.utils.toArray('.trip-section'), document.getElementById('explore')]
      sections.forEach((section, i) => {
        const from = keys[i]
        const to = keys[i + 1]
        const vF = latLonToVec3(from.lat, from.lon, 1)
        const vT = latLonToVec3(to.lat, to.lon, 1)
        const angle = vF.angleTo(vT)
        const sinA = Math.sin(angle)
        // stay low: barely climb on short hops, modest rise on long ones
        const climb = 0.06 + Math.min(angle * 0.5, 0.55)
        ScrollTrigger.create({
          trigger: section,
          start: 'top bottom',
          end: 'top top',
          onUpdate: (self) => {
            const e = ease(self.progress)
            const dir = slerpDir(vF, vT, e, angle, sinA)
            cam.lat = Math.asin(dir.y) * R2D
            cam.lon = Math.atan2(-dir.z, dir.x) * R2D
            const flight = Math.sin(Math.PI * e)
            cam.dist = from.dist + (to.dist - from.dist) * e + flight * climb
            // gaze ahead over the terrain mid-flight, back to the city at rest
            const ahead = slerpDir(vF, vT, Math.min(e + 0.14, 1), angle, sinA)
            const gaze = flight * 0.85
            cam.lx = ahead.x * gaze
            cam.ly = ahead.y * gaze
            cam.lz = ahead.z * gaze
            globe.routeProgress = from.route + (to.route - from.route) * e
          },
        })
      })

      // ---- card reveals + active-section tracking ----
      gsap.utils.toArray('.trip-section').forEach((section, i) => {
        gsap.from(section.querySelectorAll('.tc-anim'), {
          y: 44,
          autoAlpha: 0,
          duration: 0.7,
          stagger: 0.07,
          ease: 'power3.out',
          scrollTrigger: {
            trigger: section,
            start: 'top 62%',
            toggleActions: 'play none none reverse',
          },
        })
        ScrollTrigger.create({
          trigger: section,
          start: 'top center',
          end: 'bottom center',
          onToggle: (self) => {
            if (self.isActive) {
              setActiveIdx(i)
              globe.setActive(TRIPS[i].id)
            }
          },
        })
      })

      // ---- explore mode gate ----
      ScrollTrigger.create({
        trigger: '#explore',
        start: 'top 55%',
        onEnter: () => {
          exploreRef.current = true
          setExplore(true)
          globe.setExplore(true)
        },
        onLeaveBack: () => {
          exploreRef.current = false
          setExplore(false)
          setHover(null)
          globe.setExplore(false)
        },
      })

      // ---- hero entrance ----
      gsap.from('.hero .h-anim', {
        y: 60,
        autoAlpha: 0,
        duration: 1,
        stagger: 0.09,
        ease: 'power3.out',
        delay: 1.1,
      })

      // ---- top progress bar ----
      ScrollTrigger.create({
        start: 0,
        end: 'max',
        onUpdate: (self) => {
          const bar = document.getElementById('progress-bar')
          if (bar) bar.style.transform = `scaleX(${self.progress})`
        },
      })
    })

    const introTimer = setTimeout(() => setIntro(false), 1300)

    // section heights shift once the display font swaps in — remeasure so
    // camera legs stay glued to their sections
    const refresh = () => ScrollTrigger.refresh()
    document.fonts?.ready?.then(refresh)
    window.addEventListener('load', refresh)

    return () => {
      clearTimeout(introTimer)
      window.removeEventListener('load', refresh)
      ctx.revert()
      gsap.ticker.remove(tick)
      lenis.destroy()
      globe.dispose()
    }
  }, [])

  // close modal on ESC
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && closeModal()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const scrollTo = (target) => lenisRef.current?.scrollTo(target, { duration: 1.6 })

  const closeModal = () => {
    setSelected(null)
    if (globeRef.current && exploreRef.current) {
      globeRef.current.controls.autoRotate = true
    }
  }

  return (
    <>
      <FlowCursor label={hover ? 'OPEN' : explore ? 'DRAG' : ''} />

      {/* intro loader */}
      <div className={`loader ${intro ? '' : 'done'}`}>
        <div className="loader-inner">
          <span className="loader-kicker">{META.dates}</span>
          <span className="loader-title">{META.title}</span>
        </div>
      </div>

      <div id="progress-bar" />

      <header className="site-header">
        <button className="header-brand" onClick={() => scrollTo(0)}>
          EG · ABROAD '26
        </button>
        <nav>
          <span className="header-dates">{META.dates}</span>
          <button className="header-link" onClick={() => scrollTo('#explore')}>
            MAP ↓
          </button>
        </nav>
      </header>

      {/* fixed 3D stage */}
      <div ref={stageRef} className={`globe-stage ${explore ? 'interactive' : ''}`} />

      <div id="scroll-track">
        <section className="hero">
          <p className="hero-kicker h-anim">
            {META.name} — {META.home}
          </p>
          <h1 className="hero-title h-anim">{META.title}</h1>
          <p className="hero-sub h-anim">{META.subtitle}</p>
          <div className="stats h-anim">
            {META.stats.map((s) => (
              <div className="stat" key={s.label}>
                <span className="stat-value">{s.value}</span>
                <span className="stat-label">{s.label}</span>
              </div>
            ))}
          </div>
          <div className="scroll-cue h-anim">
            <span>SCROLL TO TRAVEL</span>
            <i />
          </div>
        </section>

        {TRIPS.map((trip, i) => (
          <section
            key={trip.id}
            id={`trip-${trip.id}`}
            className={`trip-section ${i % 2 ? 'right' : 'left'}`}
          >
            <div className="trip-block" style={{ '--tc': trip.color || '#ff8a3c' }}>
              <p className="trip-eyebrow tc-anim">
                W{trip.num} — {trip.month} · {trip.tag}
              </p>
              <h2 className="trip-title tc-anim">{trip.title}</h2>
              <p className="trip-place tc-anim">{trip.place}</p>
              <p className="trip-blurb tc-anim">{trip.blurb}</p>
              <p className="trip-highlights tc-anim">{trip.highlights.join(' / ')}</p>
              <Photo trip={trip} className="trip-photo tc-anim" />
            </div>
          </section>
        ))}

        <section id="explore">
          <div className="explore-head">
            <h2>EXPLORE THE MAP</h2>
            <p>
              Drag to orbit · Scroll to zoom · <b>Click a pin</b> to relive a weekend
            </p>
            <p className="explore-note">18 WEEKENDS PINNED — EVERY COLOR IS A DIFFERENT ONE</p>
          </div>
          <div className="explore-foot">
            <button className="btn-ghost" onClick={() => scrollTo(0)}>
              ↑ BACK TO THE TOP
            </button>
            <span className="credit">
              {META.name} · SPRING '26 · THE TIME OF MY LIFE
            </span>
          </div>
        </section>
      </div>

      {/* weekend rail */}
      <nav className={`rail ${intro ? 'hidden' : ''}`}>
        {TRIPS.map((trip, i) => (
          <button
            key={trip.id}
            className={`rail-num ${i === activeIdx ? 'active' : ''}`}
            style={{ '--tc': trip.color || '#ff8a3c' }}
            onClick={() => scrollTo(`#trip-${trip.id}`)}
          >
            {trip.num}
            <span className="rail-label">{trip.title}</span>
          </button>
        ))}
      </nav>

      {/* pin hover tooltip */}
      {hover && !selected && (
        <div
          className="tooltip"
          style={{ left: hover.x + 22, top: hover.y - 36, '--tc': hover.trip.color || '#ff8a3c' }}
        >
          <b>W{hover.trip.num}</b> {hover.trip.title}
        </div>
      )}

      {/* trip modal */}
      {selected && (
        <div className="modal-backdrop" onClick={closeModal}>
          <div
            className="modal"
            style={{ '--tc': selected.color || '#ff8a3c' }}
            onClick={(e) => e.stopPropagation()}
          >
            <button className="modal-close" onClick={closeModal}>
              ✕
            </button>
            <Photo trip={selected} className="modal-photo" />
            <div className="modal-body">
              <p className="trip-eyebrow">
                W{selected.num} — {selected.month} · {selected.tag}
              </p>
              <h3>{selected.title}</h3>
              <p className="trip-place">{selected.place}</p>
              <p className="trip-blurb">{selected.blurb}</p>
              <p className="trip-highlights">{selected.highlights.join(' / ')}</p>
            </div>
          </div>
        </div>
      )}

      {/* builder credit / contact */}
      <a className="site-credit" href="mailto:ethan.goldstein.dev@gmail.com">
        by Ethan Goldstein · ethan.goldstein.dev@gmail.com
      </a>
    </>
  )
}
