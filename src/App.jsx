import { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ReferenceLine, ResponsiveContainer } from "recharts";

const MODES = [
  { id: "none", name: "Send without checking", tag: "No protection", blurb: "The sender sends as fast as it can, without checking whether the receiver has room. A full buffer means dropped data." },
  { id: "stop_and_wait", name: "Send one, then wait", tag: "One at a time", blurb: "The sender waits for a reply after every segment. It avoids overflow, but the link sits idle while each reply travels back." },
  { id: "sliding_window", name: "Send a small batch", tag: "Fixed-size window", blurb: "The sender can have several segments in transit at once. A fixed limit keeps things moving, but it needs to suit the link and receiver." },
  { id: "credit", name: "Let the receiver set the pace", tag: "Adaptive · TCP-style", blurb: "The receiver tells the sender how much free space it has. The sender adjusts automatically, helping prevent overflow while keeping data moving." },
];

const DEFAULTS = { send_rate: 2, consume_rate: 1, buffer_size: 20, prop_delay: 5, window: 8, total_packets: 300 };

const PRESETS = [
  { name: "Bottleneck link", p: DEFAULTS },
  { name: "Long fat pipe", p: { ...DEFAULTS, send_rate: 3, consume_rate: 3, buffer_size: 30, prop_delay: 15, window: 12 } },
  { name: "Tiny receive buffer", p: { ...DEFAULTS, buffer_size: 3, prop_delay: 2 } },
  { name: "Matched rates", p: { ...DEFAULTS, send_rate: 1, consume_rate: 1.5 } },
];

const SLIDERS = [
  { k: "send_rate", label: "Sending speed", unit: "segments / tick", min: 0.5, max: 6, step: 0.5, group: "Sender" },
  { k: "consume_rate", label: "Reading speed", unit: "segments / tick", min: 0.25, max: 6, step: 0.25, group: "Receiver" },
  { k: "buffer_size", label: "Buffer capacity", unit: "segments", min: 1, max: 60, step: 1, group: "Receiver" },
  { k: "prop_delay", label: "Travel time (one way)", unit: "ticks", min: 1, max: 20, step: 1, group: "Link" },
  { k: "window", label: "Maximum batch size", unit: "segments", min: 1, max: 60, step: 1, only: "sliding_window", group: "Link" },
];

const CONTROL_GROUPS = [
  { name: "Sender", description: "How quickly data leaves Host A." },
  { name: "Receiver", description: "How quickly Host B reads data and how much it can hold." },
  { name: "Link", description: "How long data takes to travel between hosts." },
];

const COLORS = { water: "#2b6e99", spill: "#d64550", amber: "#e0a030", green: "#3f9d63", ink: "#16222e", mute: "#6b7b89" };

// One-line, colour-coded verdict so the network state is obvious at a glance.
function verdict(sum) {
  if (!sum) return null;
  if (sum.drops > 0)
    return { tone: "bad", title: `Receiver buffer full — ${sum.drops} segments dropped`,
      sub: "Data is arriving faster than the receiver can make room. Dropped segments must be sent again, wasting time and link capacity." };
  if (sum.sender_stall_pct >= 40)
    return { tone: "warn", title: `Sender waiting — idle ${sum.sender_stall_pct}% of the time`,
      sub: "The sender is waiting for room or a reply. Try a larger batch or a faster return trip to keep data moving." };
  return { tone: "ok", title: `Smooth delivery — ${Math.round(sum.efficiency * 100)}% of sends were useful`,
    sub: "The sender keeps data moving without filling the receiver's buffer. These settings are a good match for this connection." };
}

function useApi(url, body) {
  const [state, setState] = useState({ data: null, error: null });
  const key = JSON.stringify(body);
  useEffect(() => {
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: key, signal: ctrl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setState({ data: await r.json(), error: null });
      } catch (e) {
        if (e.name !== "AbortError") setState((s) => ({ ...s, error: "Cannot reach the backend. Start it with: uvicorn main:app --reload" }));
      }
    }, 250);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [url, key]);
  return state;
}

function PipeLegend() {
  const items = [
    { c: COLORS.amber, label: "data segments →", dash: false },
    { c: COLORS.water, label: "receive queue", dash: false },
    { c: COLORS.green, label: "receiver replies ←", dash: true },
    { c: COLORS.spill, label: "dropped at receiver", dash: false },
  ];
  return (
    <div className="legend" aria-hidden="true">
      {items.map((it) => (
        <span key={it.label}><i style={{ background: it.c, borderRadius: it.dash ? "1px" : "50%", height: it.dash ? "3px" : "9px" }} />{it.label}</span>
      ))}
    </div>
  );
}

function Pipe({ s, params, limit, mode }) {
  const cap = params.buffer_size;
  const fill = Math.min(1, s.buffer / cap);
  const H = 150;
  const dots = Math.min(s.inflight, 28);
  const spilling = s.spill;
  const rtt = params.prop_delay * 2;
  const bdp = Math.max(1, Math.ceil(rtt * params.send_rate)); // segments the pipe can hold
  const limitLabel = mode === "stop_and_wait" ? 1 : mode === "sliding_window" ? params.window : mode === "credit" ? "rwnd" : null;
  return (
    <svg viewBox="0 0 560 250" className="pipe" role="img" aria-label="Host A sending data to Host B, which returns ACKs">
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill={COLORS.mute} />
        </marker>
        <marker id="arrAck" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill={COLORS.green} />
        </marker>
      </defs>

      {/* Host A (sender) */}
      <rect x="8" y="70" width="112" height="96" rx="8" fill={COLORS.ink} />
      <text x="64" y="100" fill="#fff" textAnchor="middle" fontSize="14" fontWeight="700">Host A</text>
      <text x="64" y="118" fill="#cfe0ec" textAnchor="middle" fontSize="11">sender</text>
      <text x="64" y="140" fill="#fff" textAnchor="middle" fontSize="13" fontWeight="700">{s.inflight} on the way</text>
      {limitLabel != null && <text x="64" y="156" fill={COLORS.amber} textAnchor="middle" fontSize="11">window {limitLabel}</text>}

      {/* the link: data → on top, ACK ← below */}
      <rect x="126" y="98" width="300" height="16" fill="#e7edf1" />
      {Array.from({ length: dots }).map((_, i) => (
        <circle key={i} cx={140 + (i * 272) / Math.max(dots, 8)} cy="106" r="4.5" fill={COLORS.amber} />
      ))}
      <text x="276" y="90" textAnchor="middle" fontSize="12" fill={COLORS.mute}>data → · {params.prop_delay} ticks to travel</text>
      <line x1="140" y1="130" x2="404" y2="130" stroke={COLORS.green} strokeWidth="2" strokeDasharray="7 5" markerEnd="url(#arrAck)" />
      <text x="276" y="150" textAnchor="middle" fontSize="12" fill={COLORS.green}>← receiver replies · {rtt} ticks round trip</text>

      {/* Host B (receiver) with its receive queue */}
      <text x="478" y="26" textAnchor="middle" fontSize="12" fontWeight="600" fill={COLORS.ink}>Host B · receive queue</text>
      <rect x="440" y="34" width="76" height={H} rx="4" fill="#fff" stroke={COLORS.ink} strokeWidth="2" />
      <rect x="442" y={34 + H - H * fill} width="72" height={H * fill} fill={spilling ? COLORS.spill : COLORS.water} />
      <text x="478" y="116" textAnchor="middle" fontSize="17" fontWeight="800" fill={fill > 0.45 ? "#fff" : COLORS.ink}>{s.buffer}/{cap}</text>
      {spilling && <text x="478" y="196" textAnchor="middle" fontSize="12" fontWeight="800" fill={COLORS.spill}>queue full · DROP</text>}
      {!spilling && <text x="478" y="196" textAnchor="middle" fontSize="11" fill={COLORS.mute}>app reads {params.consume_rate}/tick</text>}

      {/* A plain-language reminder of how many segments keep the link busy. */}
      <text x="276" y="200" textAnchor="middle" fontSize="11" fill={COLORS.mute}>
        to keep the link busy, about {bdp} segments need to be on the way
      </text>
      {spilling && <text x="276" y="222" textAnchor="middle" fontSize="12" fontWeight="700" fill={COLORS.spill}>Receiver buffer full · incoming data was dropped</text>}
    </svg>
  );
}

function Charts({ series, tick, cap }) {
  const common = { data: series, margin: { top: 8, right: 16, left: 0, bottom: 0 } };
  return (
    <div className="charts">
      <div>
        <h3>Receive-queue occupancy</h3>
        <p className="cap">How full Host B's buffer is over time. The dashed red line is its size — whenever the blue line rides it, the queue is full and segments are dropped.</p>
        <ResponsiveContainer width="100%" height={190}>
          <LineChart {...common}>
            <XAxis dataKey="t" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} domain={[0, Math.max(cap + 2, 5)]} />
            <Tooltip />
            <ReferenceLine y={cap} stroke={COLORS.spill} strokeDasharray="5 4" label={{ value: "buffer size", fontSize: 11, fill: COLORS.spill, position: "insideTopRight" }} />
            <ReferenceLine x={tick} stroke={COLORS.ink} />
            <Line dataKey="buffer" name="queued at receiver" stroke={COLORS.water} dot={false} strokeWidth={2} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div>
        <h3>Sent vs. delivered vs. dropped</h3>
        <p className="cap">Amber is everything the sender transmitted; blue is what the app actually received; red is what was dropped at the queue. A widening gap between amber and blue means wasted transmissions.</p>
        <ResponsiveContainer width="100%" height={190}>
          <LineChart {...common}>
            <XAxis dataKey="t" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <ReferenceLine x={tick} stroke={COLORS.ink} />
            <Line dataKey="sent" name="transmitted" stroke={COLORS.amber} dot={false} strokeWidth={2} isAnimationActive={false} />
            <Line dataKey="delivered" name="delivered to app" stroke={COLORS.water} dot={false} strokeWidth={2} isAnimationActive={false} />
            <Line dataKey="drops" name="dropped" stroke={COLORS.spill} dot={false} strokeWidth={2} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const COLS = [
  ["ticks", "Time to finish", (v) => v],
  ["goodput", "Delivered / tick", (v) => v],
  ["drops", "Dropped", (v) => v],
  ["efficiency", "Useful sends", (v) => `${Math.round(v * 100)}%`],
  ["avg_latency", "Average trip", (v) => v],
  ["sender_stall_pct", "Sender waiting", (v) => `${v}%`],
  ["peak_buffer", "Most in buffer", (v) => v],
];

export default function App() {
  const [params, setParams] = useState(DEFAULTS);
  const [mode, setMode] = useState("none");
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(true);
  const one = useApi("/api/simulate", { ...params, mode });
  const all = useApi("/api/compare", params);
  const series = one.data?.series ?? [];
  const sum = one.data?.summary;
  const step = Math.max(1, Math.ceil(series.length / 250));

  useEffect(() => { setTick(0); setPlaying(true); }, [one.data]);
  useEffect(() => {
    if (!playing || !series.length) return;
    const id = setInterval(() => setTick((t) => {
      if (t >= series.length - 1) { setPlaying(false); return t; }
      return Math.min(t + step, series.length - 1);
    }), 40);
    return () => clearInterval(id);
  }, [playing, series, step]);

  const cur = series[Math.min(tick, series.length - 1)];
  const spill = cur && tick >= 3 && cur.drops > series[tick - 3].drops;
  const modeInfo = MODES.find((m) => m.id === mode);
  const error = one.error || all.error;
  const vd = verdict(sum);

  return (
    <main>
      <header className="hero">
        <p className="eyebrow">A hands-on networking lab</p>
        <h1>Keep data moving.<br />Protect the receiver.</h1>
        <p>Flow control helps one computer send data at a pace another can handle. Choose a sending rule, adjust the connection, and watch what happens.</p>
        <div className="steps" aria-label="How to use the simulator">
          <span><b>1</b> Choose a sending rule</span>
          <span><b>2</b> Set up the connection</span>
          <span><b>3</b> Watch and compare</span>
        </div>
      </header>

      {error && <p className="error" role="alert">{error}</p>}

      <section className="mode-picker" aria-label="Choose a sending rule">
        <div className="section-heading">
          <span className="step-number">01</span>
          <div><h2>How should the sender behave?</h2><p>Pick a rule to see how it affects delivery.</p></div>
        </div>
        <div className="modes" role="group" aria-label="Sending rule">
        {MODES.map((m) => (
          <button key={m.id} className={m.id === mode ? "on" : ""} aria-pressed={m.id === mode} onClick={() => setMode(m.id)}>
            <span className="mname">{m.name}</span>
            <span className="mtag">{m.tag}</span>
          </button>
        ))}
        </div>
        <p className="blurb">{modeInfo.blurb}</p>
      </section>

      <div className="layout">
        <aside>
          <div className="section-heading compact">
            <span className="step-number">02</span>
            <div><h2>Set up the connection</h2><p>Change a setting to see the simulation update.</p></div>
          </div>
          <div className="preset-area">
            <h3>Start with an example</h3>
            <div className="presets">
              {PRESETS.map((p) => <button key={p.name} onClick={() => setParams(p.p)}>{p.name}</button>)}
            </div>
          </div>
          {CONTROL_GROUPS.map((group) => (
            <div className="control-group" key={group.name}>
              <h3>{group.name}</h3>
              <p>{group.description}</p>
              {SLIDERS.filter((slider) => slider.group === group.name).map((s) => (
                <label key={s.k} className={s.only && s.only !== mode ? "dim" : ""}>
                  <span>{s.label}<b>{params[s.k]} <small>{s.unit}</small></b></span>
                  <input aria-label={s.label} type="range" min={s.min} max={s.max} step={s.step} value={params[s.k]}
                         onChange={(e) => setParams({ ...params, [s.k]: Number(e.target.value) })} />
                </label>
              ))}
            </div>
          ))}
          <p className="hint">Batch size is used only by “Send a small batch.”</p>
          <div className="netfacts">
            <div><span>Round trip</span><b>{params.prop_delay * 2} ticks</b></div>
            <div><span>Segments to fill link</span><b>{Math.max(1, Math.ceil(params.prop_delay * 2 * params.send_rate))}</b></div>
          </div>
        </aside>

        <section className="stage">
          <div className="section-heading compact stage-heading">
            <span className="step-number">03</span>
            <div><h2>Watch the connection</h2><p>Data moves to the receiver; replies travel back to the sender.</p></div>
          </div>
          {vd && <div className={"verdict " + vd.tone} role="status">
            <strong>{vd.title}</strong>
            <span>{vd.sub}</span>
          </div>}
          {cur && <Pipe s={{ ...cur, spill }} params={params} mode={mode}
                        limit={mode === "stop_and_wait" ? 1 : mode === "sliding_window" ? params.window : mode === "credit" ? "rwnd" : null} />}
          <PipeLegend />
          <div className="player">
            <button onClick={() => (tick >= series.length - 1 ? (setTick(0), setPlaying(true)) : setPlaying(!playing))}>
              {playing ? "Pause" : tick >= series.length - 1 ? "Replay" : "Play"}
            </button>
            <input type="range" aria-label="Simulation time" min="0" max={Math.max(series.length - 1, 0)} value={tick}
                   onChange={(e) => { setPlaying(false); setTick(Number(e.target.value)); }} />
            <span>t = {cur?.t ?? 0}</span>
          </div>
          {sum && <div className="kpis">
            <div className="kpi"><b>{sum.delivered}</b><span>delivered</span></div>
            <div className={"kpi" + (sum.drops ? " bad" : "")}><b>{sum.drops}</b><span>dropped</span></div>
            <div className="kpi"><b>{sum.goodput}</b><span>delivered / tick</span></div>
            <div className="kpi"><b>{Math.round(sum.efficiency * 100)}%</b><span>useful sends</span></div>
            <div className="kpi"><b>{sum.ticks}</b><span>ticks to drain</span></div>
          </div>}
          {sum && <p className="result">
            {sum.drops === 0 ? "No segments lost on this link." : `${sum.drops} segments dropped at the receiver.`}{" "}
            {sum.delivered} delivered in {sum.ticks} ticks{sum.completed ? "" : " (transfer unfinished)"}.
          </p>}
          {series.length > 0 && <Charts series={series} tick={cur?.t ?? 0} cap={params.buffer_size} />}
        </section>
      </div>

      <section className="compare">
        <div className="section-heading compact">
          <span className="step-number">04</span>
          <div><h2>Compare the four rules</h2><p>Each rule uses the same connection settings.</p></div>
        </div>
        <p className="cap">“Dropped” shows data that could not fit in the receiver's buffer. The highlighted row is your current choice.</p>
        {all.data && (
          <>
            <div className="scroll">
              <table>
                <thead><tr><th>Strategy</th>{COLS.map((c) => <th key={c[0]}>{c[1]}</th>)}</tr></thead>
                <tbody>
                  {all.data.results.map((r) => (
                    <tr key={r.mode} className={r.mode === mode ? "cur" : ""}>
                      <th>{MODES.find((m) => m.id === r.mode).name}</th>
                      {COLS.map(([k, , f]) => <td key={k} className={k === "drops" && r.summary[k] > 0 ? "bad" : ""}>{f(r.summary[k])}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="notes">{all.data.analysis.map((n, i) => <li key={i}>{n}</li>)}</ul>
          </>
        )}
      </section>
    </main>
  );
}
