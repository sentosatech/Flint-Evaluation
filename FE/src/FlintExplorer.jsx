import React, { useState, useMemo, useCallback } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ---------- design tokens ----------

const COLORS = {
  bg: "#F7F6F2",
  panel: "#FFFFFF",
  ink: "#181715",
  muted: "#6B6862",
  rule: "#E4E0D8",
  warn: "#B45309",
  err: "#B91C1C",
  good: "#15803D",
};

// Four distinct file colors — used everywhere a file is identified.
const FILE_COLORS = ["#0E6E78", "#C2410C", "#6D28D9", "#1E40AF"];

const FONT_SANS =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const FONT_MONO =
  '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace';

// ---------- metric grouping ----------

const METRIC_GROUPS = [
  {
    name: "Airtime & Congestion",
    metrics: [
      "channel_active_time",
      "channel_busy_time",
      "channel_tx_time",
      "channel_rx_time",
      "channel_utilization_pct",
      "own_tx_time",
      "own_rx_time",
      "per_station_tx_bytes",
      "per_station_tx_packets",
      "per_station_rx_bytes",
      "per_station_rx_packets",
      "active_client_count",
    ],
  },
  {
    name: "Client Link Health",
    metrics: [
      "per_station_rssi",
      "per_station_rssi_avg",
      "per_station_phy_rate_tx",
      "per_station_phy_rate_rx",
      "per_station_tx_retries",
      "per_station_tx_failed",
      "per_station_rx_drops",
      "per_station_connected_time",
      "per_station_inactive_time",
    ],
  },
  {
    name: "Neighbor Scan",
    metrics: ["neighbor_bss_list"],
  },
  {
    name: "Errors (optional)",
    metrics: ["tx_xretry_count", "fcs_error_count"],
  },
  {
    name: "Universal",
    metrics: ["operating_channel", "connected_device_count_per_band"],
  },
];

const IMPORTANCE_LEVELS = ["critical", "important", "optional"];
const BAND_OPTIONS = ["2.4GHz", "5GHz", "6GHz", "global"];

// ---------- helpers ----------

function scopeKey(scope) {
  if (!scope) return "";
  return [scope.iface || "", scope.band || "", scope.client_mac || ""].join("|");
}

function scopeLabel(scope) {
  if (!scope) return "global";
  const parts = [];
  if (scope.iface) parts.push(scope.iface);
  if (scope.band) parts.push(scope.band);
  if (scope.client_mac) {
    const m = scope.client_mac;
    parts.push(m.length > 6 ? "…" + m.slice(-5) : m);
  }
  return parts.length ? parts.join(" · ") : "global";
}

function metricBand(meta) {
  return meta.scope?.band || "global";
}

function statsFromValues(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((s, v) => s + v, 0);
  const mean = sum / n;
  const median =
    n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
  const min = sorted[0];
  const max = sorted[n - 1];
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  return { n, sum, mean, median, p95, min, max, stddev };
}

function extractSeries(metric) {
  if (!metric || !metric.samples) return [];
  switch (metric.value_type) {
    case "cumulative_counter":
      return metric.samples
        .map((s) => (s.delta == null ? null : Number(s.delta)))
        .filter((v) => v != null && Number.isFinite(v));
    case "instant":
      return metric.samples
        .map((s) => (s.value == null ? null : Number(s.value)))
        .filter((v) => v != null && Number.isFinite(v));
    case "snapshot":
      return metric.samples.map((s) => Number(s.count || 0));
    default:
      return [];
  }
}

function extractSampleValue(s, valueType) {
  switch (valueType) {
    case "cumulative_counter":
      return s.delta == null ? null : Number(s.delta);
    case "instant":
      return s.value == null ? null : Number(s.value);
    case "snapshot":
      return Number(s.count || 0);
    default:
      return null;
  }
}

function fmt(v, unit) {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  let d;
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + " G" + (unit || "");
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + " M" + (unit || "");
  if (abs >= 1e4)
    return Math.round(v).toLocaleString() + (unit ? " " + unit : "");
  if (abs >= 100) d = 0;
  else if (abs >= 10) d = 1;
  else if (abs >= 1) d = 2;
  else if (abs > 0) d = 3;
  else d = 0;
  return v.toFixed(d) + (unit ? " " + unit : "");
}

function fmtDuration(seconds) {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

function toRelativeSec(sampleTime, runStart) {
  const t = new Date(sampleTime).getTime();
  const s = new Date(runStart).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(s)) return null;
  return Math.round((t - s) / 1000);
}

function primaryStats(hint) {
  switch (hint) {
    case "median_p95":
      return ["median", "p95", "max"];
    case "median_stddev_min_max":
      return ["median", "stddev", "min", "max"];
    case "rate_sum_max":
      return ["sum", "max", "mean"];
    case "max_average":
      return ["max", "mean"];
    case "latest":
    case "latest_count":
      return ["latest"];
    case "delta_per_window":
      return ["median", "p95", "max"];
    default:
      return ["median", "max"];
  }
}

function getMetric(data, metricId, scope) {
  return (data.metrics || []).find(
    (m) => m.metric_id === metricId && scopeKey(m.scope) === scopeKey(scope)
  );
}

// ---------- file loading ----------

function loadFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.run || !Array.isArray(data.metrics)) {
          reject(new Error("Not a flint3-probe JSON — missing run or metrics"));
          return;
        }
        resolve(data);
      } catch (e) {
        reject(new Error("Invalid JSON: " + e.message));
      }
    };
    reader.onerror = () => reject(new Error("Read failed"));
    reader.readAsText(file);
  });
}

// ---------- section header ----------

function SectionHeader({ label, title, hint, collapsible, collapsed, onToggle }) {
  const clickable = collapsible && onToggle;
  return (
    <div
      style={{
        marginBottom: collapsible && collapsed ? 8 : 14,
        cursor: clickable ? "pointer" : "default",
        userSelect: clickable ? "none" : "auto",
      }}
      onClick={clickable ? onToggle : undefined}
    >
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: COLORS.muted,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <h2
        style={{
          fontSize: 20,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: COLORS.ink,
          margin: 0,
          display: "flex",
          alignItems: "baseline",
          gap: 10,
        }}
      >
        {collapsible && (
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 14,
              color: COLORS.muted,
              width: 14,
              display: "inline-block",
            }}
            aria-label={collapsed ? "expand" : "collapse"}
          >
            {collapsed ? "▸" : "▾"}
          </span>
        )}
        {title}
        {hint && (
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 12,
              fontWeight: 400,
              color: COLORS.muted,
            }}
          >
            {hint}
          </span>
        )}
      </h2>
    </div>
  );
}

// ---------- slot component ----------

function FileSlot({ slot, file, color, onLoad, onRemove, onRename }) {
  const [drag, setDrag] = useState(false);
  const handleFile = useCallback(
    async (f) => {
      if (!f) return;
      try {
        const data = await loadFile(f);
        onLoad(slot, {
          name: f.name,
          size: f.size,
          data,
          label: f.name.replace(/\.json$/i, ""),
        });
      } catch (e) {
        onLoad(slot, { name: f.name, size: f.size, error: e.message });
      }
    },
    [slot, onLoad]
  );
  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDrag(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) handleFile(f);
    },
    [handleFile]
  );

  if (!file) {
    return (
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        style={{
          display: "block",
          background: drag ? `${color}10` : COLORS.panel,
          border: `1px ${drag ? "solid" : "dashed"} ${drag ? color : COLORS.rule}`,
          padding: "20px 16px",
          borderRadius: 3,
          cursor: "pointer",
          minHeight: 96,
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color,
            fontWeight: 600,
            marginBottom: 6,
          }}
        >
          ▸ file {slot + 1}
        </div>
        <div style={{ fontFamily: FONT_SANS, fontSize: 13, color: COLORS.muted }}>
          Drop JSON or click
        </div>
        <input
          type="file"
          accept=".json,application/json"
          onChange={(e) => handleFile(e.target.files?.[0])}
          style={{ display: "none" }}
        />
      </label>
    );
  }

  return (
    <div
      style={{
        background: COLORS.panel,
        border: `1px solid ${color}`,
        padding: "14px 16px",
        borderRadius: 3,
        minHeight: 96,
        position: "relative",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 8,
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color,
            fontWeight: 600,
          }}
        >
          ▸ file {slot + 1}
        </div>
        <button
          onClick={() => onRemove(slot)}
          style={{
            background: "transparent",
            border: "none",
            color: COLORS.muted,
            cursor: "pointer",
            fontSize: 14,
            padding: 0,
            fontFamily: FONT_MONO,
          }}
          title="Remove"
        >
          ×
        </button>
      </div>
      {file.error ? (
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            color: COLORS.err,
            lineHeight: 1.4,
          }}
        >
          {file.error}
        </div>
      ) : (
        <>
          <input
            type="text"
            value={file.label}
            onChange={(e) => onRename(slot, e.target.value)}
            style={{
              width: "100%",
              background: "transparent",
              border: "none",
              outline: "none",
              padding: 0,
              fontFamily: FONT_SANS,
              fontSize: 13,
              fontWeight: 500,
              color: COLORS.ink,
              marginBottom: 4,
            }}
          />
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 10,
              color: COLORS.muted,
              lineHeight: 1.5,
            }}
          >
            {file.data && (
              <>
                <div>
                  {fmtDuration(file.data.run.duration_seconds)} ·{" "}
                  {file.data.metrics.length} metrics
                </div>
                <div>{file.data.clients_seen?.length || 0} client(s) seen</div>
                <div>v{file.data.run.probe_version}</div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- overview cards ----------

function OverviewStrip({ files }) {
  const loaded = files.filter((f) => f && f.data);
  if (!loaded.length) return null;
  return (
    <section style={{ marginBottom: 32 }}>
      <SectionHeader label="run overview" title="Sample overview" />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.min(loaded.length, 4)}, 1fr)`,
          gap: 12,
        }}
      >
        {files.map((f, idx) => {
          if (!f || !f.data) return null;
          return <OverviewCard key={idx} file={f} color={FILE_COLORS[idx]} />;
        })}
      </div>
    </section>
  );
}

function OverviewCard({ file, color }) {
  const { run, radios = [], clients_seen = [], environment = {} } = file.data;
  const activeBands = radios
    .filter((r) => !r.is_mlo && r.band)
    .map((r) => r.band);
  return (
    <div
      style={{
        background: COLORS.panel,
        border: `1px solid ${COLORS.rule}`,
        borderTop: `2px solid ${color}`,
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color,
          fontWeight: 600,
          marginBottom: 8,
        }}
      >
        {file.label}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "4px 12px",
          fontFamily: FONT_MONO,
          fontSize: 11,
        }}
      >
        <span style={{ color: COLORS.muted }}>duration</span>
        <span style={{ color: COLORS.ink, textAlign: "right" }}>
          {fmtDuration(run.duration_seconds)}
        </span>
        <span style={{ color: COLORS.muted }}>started</span>
        <span style={{ color: COLORS.ink, textAlign: "right" }}>
          {new Date(run.start_time).toUTCString().slice(5, 22)}
        </span>
        <span style={{ color: COLORS.muted }}>host</span>
        <span style={{ color: COLORS.ink, textAlign: "right" }}>
          {run.hostname || "—"}
        </span>
        <span style={{ color: COLORS.muted }}>probe</span>
        <span style={{ color: COLORS.ink, textAlign: "right" }}>
          v{run.probe_version}
        </span>
        <span style={{ color: COLORS.muted }}>bands</span>
        <span style={{ color: COLORS.ink, textAlign: "right" }}>
          {activeBands.length ? activeBands.join(", ") : "—"}
        </span>
        <span style={{ color: COLORS.muted }}>clients</span>
        <span style={{ color: COLORS.ink, textAlign: "right" }}>
          {clients_seen.length}
        </span>
        <span style={{ color: COLORS.muted }}>failed cmds</span>
        <span
          style={{
            textAlign: "right",
            color: environment.commands_that_failed?.length
              ? COLORS.warn
              : COLORS.good,
          }}
        >
          {environment.commands_that_failed?.length || 0}
        </span>
      </div>
      {clients_seen.length > 0 && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: `1px solid ${COLORS.rule}`,
          }}
        >
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: COLORS.muted,
              fontWeight: 600,
              marginBottom: 8,
            }}
          >
            clients
          </div>
          {clients_seen.map((c, idx) => (
            <ClientDetail key={c.mac} client={c} isLast={idx === clients_seen.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// One client rendered as a labelled key-value table with spreadsheet row
// references. Each field's origin (which spreadsheet row it corresponds to)
// is shown in the rightmost column so the FE stays anchored to the source of
// truth. Fields with no spreadsheet row (session timing, MAC) show no ref.
function ClientDetail({ client, isLast }) {
  const c = client;
  const caps = c.capabilities || {};
  const flagChar = (present) => (present ? "✓" : "─");
  const flagsStr = `${flagChar(caps.ht)} ${flagChar(caps.vht)} ${flagChar(caps.he)} ${flagChar(caps.eht)}`;
  const shortTime = (ts) => {
    if (!ts) return "—";
    try {
      return new Date(ts).toISOString().slice(11, 19);
    } catch {
      return "—";
    }
  };
  const bandsStr =
    caps.supported_bands && caps.supported_bands.length
      ? caps.supported_bands.join(", ")
      : "—";

  return (
    <div
      style={{
        marginBottom: isLast ? 0 : 14,
        paddingBottom: isLast ? 0 : 12,
        borderBottom: isLast ? "none" : `1px dashed ${COLORS.rule}`,
      }}
    >
      <div
        style={{
          fontFamily: FONT_SANS,
          fontSize: 12,
          fontWeight: 600,
          color: COLORS.ink,
          marginBottom: 1,
        }}
      >
        {c.hostname || "(no hostname)"}
      </div>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          color: COLORS.muted,
          marginBottom: 8,
        }}
      >
        {c.mac}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr auto",
          gap: "3px 10px",
          fontFamily: FONT_MONO,
          fontSize: 10,
          alignItems: "baseline",
        }}
      >
        <ClientField
          label="iface"
          value={c.connected_iface || "—"}
          sheetRef="row 35"
        />
        <ClientField label="band" value={c.band || "—"} sheetRef="row 35" />
        <ClientField
          label="Wi-Fi gen"
          value={caps.generation || "—"}
          sheetRef="row 39"
        />
        <ClientField
          label="HT / VHT / HE / EHT"
          value={flagsStr}
          sheetRef="row 39"
          mono
        />
        <ClientField
          label="supp bands"
          value={bandsStr}
          sheetRef="rows 30, 37"
        />
        <ClientField
          label="session"
          value={`${shortTime(c.first_seen)} → ${shortTime(c.last_seen)}`}
        />
      </div>
      {bandsStr === "—" && (
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 9,
            color: COLORS.muted,
            marginTop: 6,
            fontStyle: "italic",
          }}
        >
          (supp_op_classes not advertised by this client — common for Windows)
        </div>
      )}
    </div>
  );
}

function ClientField({ label, value, sheetRef, mono }) {
  return (
    <>
      <span style={{ color: COLORS.muted }}>{label}</span>
      <span
        style={{
          color: COLORS.ink,
          fontFamily: mono ? FONT_MONO : FONT_MONO,
          letterSpacing: mono ? "0.05em" : 0,
        }}
      >
        {value}
      </span>
      <span
        style={{
          color: COLORS.muted,
          fontSize: 9,
          opacity: 0.7,
          whiteSpace: "nowrap",
        }}
      >
        {sheetRef || ""}
      </span>
    </>
  );
}

// ---------- coverage matrix ----------

function CoverageMatrix({ files, metricKeys, metricMeta }) {
  const loaded = files
    .map((f, i) => ({ f, i }))
    .filter((x) => x.f && x.f.data);
  if (!loaded.length || !metricKeys.length) return null;

  return (
    <section style={{ marginBottom: 32 }}>
      <SectionHeader
        label="coverage"
        title="Metric coverage"
        hint="which metrics have data in which files"
      />
      <div
        style={{
          background: COLORS.panel,
          border: `1px solid ${COLORS.rule}`,
          overflow: "auto",
          maxHeight: 320,
        }}
      >
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontFamily: FONT_MONO,
            fontSize: 11,
          }}
        >
          <thead
            style={{
              position: "sticky",
              top: 0,
              background: COLORS.panel,
              zIndex: 1,
            }}
          >
            <tr>
              <th
                style={{
                  textAlign: "left",
                  padding: "10px 14px",
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: COLORS.muted,
                  fontWeight: 600,
                  borderBottom: `1px solid ${COLORS.rule}`,
                }}
              >
                metric · scope
              </th>
              <th
                style={{
                  textAlign: "left",
                  padding: "10px 8px",
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: COLORS.muted,
                  fontWeight: 600,
                  borderBottom: `1px solid ${COLORS.rule}`,
                }}
              >
                importance
              </th>
              {loaded.map(({ i }) => (
                <th
                  key={i}
                  style={{
                    textAlign: "center",
                    padding: "10px 8px",
                    fontSize: 10,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: FILE_COLORS[i],
                    fontWeight: 600,
                    borderBottom: `1px solid ${COLORS.rule}`,
                    minWidth: 60,
                  }}
                >
                  F{i + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metricKeys.map((key) => {
              const meta = metricMeta[key];
              return (
                <tr key={key}>
                  <td
                    style={{
                      padding: "6px 14px",
                      borderBottom: `1px solid ${COLORS.rule}`,
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span style={{ color: COLORS.ink }}>{meta.metric_id}</span>
                    <span style={{ color: COLORS.muted, marginLeft: 8 }}>
                      · {scopeLabel(meta.scope)}
                    </span>
                  </td>
                  <td
                    style={{
                      padding: "6px 8px",
                      borderBottom: `1px solid ${COLORS.rule}`,
                      color: COLORS.muted,
                    }}
                  >
                    {meta.importance}
                  </td>
                  {loaded.map(({ f, i }) => {
                    const m = getMetric(f.data, meta.metric_id, meta.scope);
                    return (
                      <td
                        key={i}
                        style={{
                          padding: "6px 8px",
                          textAlign: "center",
                          borderBottom: `1px solid ${COLORS.rule}`,
                        }}
                      >
                        {m ? (
                          <CoverageCell metric={m} color={FILE_COLORS[i]} />
                        ) : (
                          <span style={{ color: COLORS.rule }}>—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CoverageCell({ metric, color }) {
  const n = metric.samples?.length || 0;
  const bad =
    metric.status === "not_available" ||
    metric.status === "parse_error" ||
    metric.status === "empty_output" ||
    metric.status === "scan_unsupported";
  if (bad || n === 0) {
    return (
      <span
        title={metric.status}
        style={{ fontFamily: FONT_MONO, fontSize: 10, color: COLORS.warn }}
      >
        ⚠
      </span>
    );
  }
  return (
    <span
      style={{
        display: "inline-block",
        minWidth: 40,
        padding: "2px 6px",
        background: `${color}18`,
        color,
        fontFamily: FONT_MONO,
        fontSize: 10,
        borderRadius: 2,
      }}
      title={`${n} samples, status: ${metric.status}`}
    >
      {n}
    </span>
  );
}

// ---------- filter bar ----------

function FilterBar({
  showOnlyWithData,
  setShowOnlyWithData,
  importanceFilter,
  setImportanceFilter,
  bandFilter,
  setBandFilter,
  clientFilter,
  setClientFilter,
  knownClients,
  showClientComparison,
  setShowClientComparison,
  search,
  setSearch,
  visibleCount,
  totalCount,
}) {
  const toggle = (map, setMap, key) =>
    setMap({ ...map, [key]: !map[key] });

  return (
    <div
      style={{
        background: COLORS.panel,
        border: `1px solid ${COLORS.rule}`,
        padding: "12px 16px",
        marginBottom: 20,
        display: "flex",
        flexWrap: "wrap",
        gap: 16,
        alignItems: "center",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: COLORS.muted,
            fontWeight: 600,
          }}
        >
          importance
        </span>
        {IMPORTANCE_LEVELS.map((lvl) => (
          <FilterChip
            key={lvl}
            active={importanceFilter[lvl]}
            onClick={() => toggle(importanceFilter, setImportanceFilter, lvl)}
          >
            {lvl}
          </FilterChip>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: COLORS.muted,
            fontWeight: 600,
          }}
        >
          band
        </span>
        {BAND_OPTIONS.map((b) => (
          <FilterChip
            key={b}
            active={bandFilter[b]}
            onClick={() => toggle(bandFilter, setBandFilter, b)}
          >
            {b}
          </FilterChip>
        ))}
      </div>
      {knownClients.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: COLORS.muted,
              fontWeight: 600,
            }}
          >
            clients
          </span>
          {knownClients.map((c) => (
            <FilterChip
              key={c.mac}
              active={clientFilter[c.mac] !== false}
              onClick={() =>
                setClientFilter({
                  ...clientFilter,
                  [c.mac]: !(clientFilter[c.mac] !== false),
                })
              }
            >
              {c.label}
            </FilterChip>
          ))}
        </div>
      )}
      <input
        type="text"
        placeholder="filter by metric id or scope…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{
          flex: 1,
          minWidth: 180,
          background: COLORS.bg,
          border: `1px solid ${COLORS.rule}`,
          padding: "6px 10px",
          fontFamily: FONT_MONO,
          fontSize: 11,
          color: COLORS.ink,
          outline: "none",
        }}
      />
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontFamily: FONT_MONO,
          fontSize: 11,
          color: COLORS.muted,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <input
          type="checkbox"
          checked={showOnlyWithData}
          onChange={(e) => setShowOnlyWithData(e.target.checked)}
        />
        hide empty
      </label>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontFamily: FONT_MONO,
          fontSize: 11,
          color: COLORS.muted,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <input
          type="checkbox"
          checked={showClientComparison}
          onChange={(e) => setShowClientComparison(e.target.checked)}
        />
        show clients comparison
      </label>
      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: 10,
          color: COLORS.muted,
        }}
      >
        {visibleCount} / {totalCount} metrics
      </span>
    </div>
  );
}

function FilterChip({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: `1px solid ${active ? COLORS.ink : COLORS.rule}`,
        background: active ? COLORS.ink : "transparent",
        color: active ? COLORS.bg : COLORS.muted,
        padding: "3px 10px",
        fontFamily: FONT_MONO,
        fontSize: 10,
        letterSpacing: "0.04em",
        cursor: "pointer",
        borderRadius: 2,
      }}
    >
      {children}
    </button>
  );
}

// ---------- metric card ----------

function MetricCard({ meta, files, showOnlyWithData }) {
  const loaded = files
    .map((f, i) => ({ f, i }))
    .filter((x) => x.f && x.f.data);

  const perFile = loaded.map(({ f, i }) => {
    const metric = getMetric(f.data, meta.metric_id, meta.scope);
    const values = metric ? extractSeries(metric) : [];
    const stats = statsFromValues(values);
    const samples = metric?.samples || [];
    const lastSample = samples.length ? samples[samples.length - 1] : null;
    return {
      idx: i,
      color: FILE_COLORS[i],
      label: f.label,
      metric,
      stats,
      lastSample,
      latest:
        lastSample
          ? lastSample.value ?? lastSample.delta ?? lastSample.count
          : null,
    };
  });

  const isStateMetric = meta.aggregation_hint === "latest";
  const anyData = isStateMetric
    ? perFile.some((p) => p.lastSample != null)
    : perFile.some((p) => p.stats && p.stats.n > 0);
  if (showOnlyWithData && !anyData) return null;

  const chartData = useMemo(() => {
    const rows = new Map();
    for (const p of perFile) {
      if (!p.metric) continue;
      const start = files[p.idx]?.data?.run?.start_time;
      if (!start) continue;
      for (const s of p.metric.samples) {
        const tRel = toRelativeSec(s.t, start);
        if (tRel == null) continue;
        const v = extractSampleValue(s, p.metric.value_type);
        if (v == null || !Number.isFinite(v)) continue;
        if (!rows.has(tRel)) rows.set(tRel, { t_rel: tRel });
        rows.get(tRel)[`f${p.idx}`] = v;
      }
    }
    return Array.from(rows.values()).sort((a, b) => a.t_rel - b.t_rel);
  }, [perFile, files]);

  const statFields = primaryStats(meta.aggregation_hint);

  return (
    <div
      style={{
        background: COLORS.panel,
        border: `1px solid ${COLORS.rule}`,
        padding: "16px 18px",
        marginBottom: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <div>
          <div
            style={{
              fontFamily: FONT_SANS,
              fontSize: 15,
              fontWeight: 600,
              color: COLORS.ink,
            }}
          >
            {meta.metric_id}
            <span
              style={{
                marginLeft: 8,
                fontFamily: FONT_MONO,
                fontSize: 11,
                color: COLORS.muted,
                fontWeight: 400,
              }}
            >
              ({meta.unit})
            </span>
          </div>
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 10,
              color: COLORS.muted,
              marginTop: 2,
            }}
          >
            {scopeLabel(meta.scope)} · {meta.importance} · {meta.value_type} ·{" "}
            {meta.aggregation_hint}
          </div>
        </div>
      </div>

      {anyData ? (
        isStateMetric ? (
          <StateBlock perFile={perFile} />
        ) : (
          <>
            <StatsTable perFile={perFile} statFields={statFields} meta={meta} />
            {chartData.length > 1 && (
            <div style={{ height: 140, marginTop: 12 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartData}
                  margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
                >
                  <CartesianGrid
                    stroke={COLORS.rule}
                    strokeDasharray="2 4"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="t_rel"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(t) => `${t}s`}
                    stroke={COLORS.muted}
                    tick={{
                      fontSize: 9,
                      fontFamily: FONT_MONO,
                      fill: COLORS.muted,
                    }}
                    axisLine={{ stroke: COLORS.rule }}
                    tickLine={{ stroke: COLORS.rule }}
                  />
                  <YAxis
                    stroke={COLORS.muted}
                    tick={{
                      fontSize: 9,
                      fontFamily: FONT_MONO,
                      fill: COLORS.muted,
                    }}
                    axisLine={{ stroke: COLORS.rule }}
                    tickLine={{ stroke: COLORS.rule }}
                    width={48}
                  />
                  <Tooltip
                    contentStyle={{
                      background: COLORS.panel,
                      border: `1px solid ${COLORS.rule}`,
                      borderRadius: 2,
                      fontFamily: FONT_MONO,
                      fontSize: 10,
                      padding: "6px 10px",
                    }}
                    labelFormatter={(t) => `t = ${t}s`}
                    formatter={(value, name) => {
                      const idx = parseInt(name.slice(1), 10);
                      const p = perFile.find((x) => x.idx === idx);
                      return [fmt(value, meta.unit), p?.label || name];
                    }}
                  />
                  {perFile.map((p) => (
                    <Line
                      key={p.idx}
                      type="monotone"
                      dataKey={`f${p.idx}`}
                      stroke={p.color}
                      strokeWidth={1.4}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
        )
      ) : (
        <div
          style={{
            padding: "16px 0",
            textAlign: "center",
            fontFamily: FONT_MONO,
            fontSize: 11,
            color: COLORS.muted,
          }}
        >
          no samples in any file
        </div>
      )}

      {meta.notes && (
        <div
          style={{
            marginTop: 10,
            padding: "6px 10px",
            background: `${COLORS.warn}0a`,
            border: `1px solid ${COLORS.warn}22`,
            fontFamily: FONT_MONO,
            fontSize: 10,
            color: COLORS.muted,
            lineHeight: 1.5,
          }}
        >
          ⓘ {meta.notes}
        </div>
      )}
    </div>
  );
}

function StatsTable({ perFile, statFields, meta }) {
  const showLatest = statFields.includes("latest");
  const rows = showLatest ? ["latest"] : ["n", ...statFields];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `auto repeat(${perFile.length}, 1fr)`,
        gap: 1,
        background: COLORS.rule,
        border: `1px solid ${COLORS.rule}`,
      }}
    >
      <div style={{ background: COLORS.panel, padding: "6px 10px" }} />
      {perFile.map((p) => (
        <div
          key={p.idx}
          style={{
            background: COLORS.panel,
            padding: "6px 10px",
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: p.color,
            fontWeight: 600,
            textAlign: "right",
          }}
        >
          F{p.idx + 1}
        </div>
      ))}

      {rows.map((field) => (
        <React.Fragment key={field}>
          <div
            style={{
              background: COLORS.panel,
              padding: "5px 10px",
              fontFamily: FONT_MONO,
              fontSize: 11,
              color: COLORS.muted,
            }}
          >
            {field}
          </div>
          {perFile.map((p) => {
            const s = p.stats;
            let value;
            if (field === "latest") value = p.latest;
            else if (field === "n") value = s?.n;
            else value = s?.[field];
            const isCount = field === "n";
            return (
              <div
                key={p.idx}
                style={{
                  background: COLORS.panel,
                  padding: "5px 10px",
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  color: value == null ? COLORS.muted : COLORS.ink,
                  textAlign: "right",
                }}
              >
                {value == null
                  ? "—"
                  : isCount
                  ? value.toLocaleString()
                  : fmt(value, meta.unit)}
              </div>
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
}

// ---------- state block (for aggregation_hint="latest" metrics) ----------

// StateBlock is the alternative to StatsTable+chart for metrics that describe
// a *state* rather than a time series. Each sample carries multiple fields
// (e.g. operating_channel has channel/width_mhz/center_freq_mhz/band). Charting
// this doesn't help — what matters is the current-state value per file and
// whether files agree with each other.
function StateBlock({ perFile }) {
  // Union of all field names across files' last samples, excluding 't'.
  const fieldSet = new Set();
  for (const p of perFile) {
    if (!p.lastSample) continue;
    for (const k of Object.keys(p.lastSample)) {
      if (k !== "t") fieldSet.add(k);
    }
  }
  const fields = Array.from(fieldSet);

  const formatFieldValue = (v) => {
    if (v == null) return "—";
    if (typeof v === "number") return v.toLocaleString();
    if (typeof v === "boolean") return v ? "✓" : "─";
    return String(v);
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `auto repeat(${perFile.length}, 1fr) auto`,
        gap: 1,
        background: COLORS.rule,
        border: `1px solid ${COLORS.rule}`,
      }}
    >
      {/* Header row */}
      <div style={{ background: COLORS.panel, padding: "6px 10px" }} />
      {perFile.map((p) => (
        <div
          key={p.idx}
          style={{
            background: COLORS.panel,
            padding: "6px 10px",
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: p.color,
            fontWeight: 600,
            textAlign: "right",
          }}
        >
          F{p.idx + 1}
        </div>
      ))}
      <div
        style={{
          background: COLORS.panel,
          padding: "6px 10px",
          fontFamily: FONT_MONO,
          fontSize: 10,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: COLORS.muted,
          fontWeight: 600,
        }}
      >
        agree
      </div>

      {fields.map((field) => {
        const values = perFile.map((p) => p.lastSample?.[field]);
        // Determine if all non-null values are equal (files agree).
        const nonNull = values.filter((v) => v != null);
        const uniq = new Set(nonNull.map((v) => JSON.stringify(v)));
        const differs = uniq.size > 1;
        return (
          <React.Fragment key={field}>
            <div
              style={{
                background: COLORS.panel,
                padding: "5px 10px",
                fontFamily: FONT_MONO,
                fontSize: 11,
                color: COLORS.muted,
              }}
            >
              {field}
            </div>
            {perFile.map((p) => {
              const v = p.lastSample?.[field];
              return (
                <div
                  key={p.idx}
                  style={{
                    background: COLORS.panel,
                    padding: "5px 10px",
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: v == null ? COLORS.muted : COLORS.ink,
                    textAlign: "right",
                    fontWeight: differs && v != null ? 600 : 400,
                  }}
                >
                  {formatFieldValue(v)}
                </div>
              );
            })}
            <div
              style={{
                background: COLORS.panel,
                padding: "5px 10px",
                fontFamily: FONT_MONO,
                fontSize: 11,
                textAlign: "center",
                color: nonNull.length < 2
                  ? COLORS.muted
                  : differs
                  ? COLORS.warn
                  : COLORS.good,
              }}
              title={
                nonNull.length < 2
                  ? "only one file has this field"
                  : differs
                  ? "files disagree — worth investigating"
                  : "all files agree"
              }
            >
              {nonNull.length < 2 ? "—" : differs ? "≠" : "="}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ---------- neighbor detail ----------

// Deterministic router identifier from a probe run. Prefers a BSSID
// fingerprint (sorted MACs of the router's own radios, as captured by
// v0.3.2+ probes) — that identifier is robust against hostname collisions
// (e.g., two routers both left at default "OpenWrt"). Falls back to
// hostname for older captures that don't include per-radio BSSIDs.
function routerId(run, radios) {
  const bssids = (radios || [])
    .filter((r) => r.bssid && !r.is_mlo)
    .map((r) => (r.bssid || "").toLowerCase())
    .filter(Boolean)
    .sort();
  if (bssids.length) {
    return "bssid:" + bssids.join(",");
  }
  return run?.hostname || "unknown-router";
}

// routerLabel returns a human-friendly display string for a router,
// combining hostname with a short BSSID hint when available.
function routerLabel(hostname, bssids) {
  if (bssids && bssids.length) {
    // Show the first BSSID as a fingerprint hint; full list is available
    // separately if needed.
    return `${hostname} (${bssids[0]})`;
  }
  return hostname;
}

// Aggregate all neighbor observations, grouped first by router (hostname)
// and then by (iface, band). This keeps captures from different routers
// visually separate — you can't meaningfully union neighbor observations
// from different physical locations, because they see different neighbors.
// When multiple files come from the same router, they DO get unioned within
// that router's group (richer picture across sessions).
function aggregateNeighbors(files) {
  // Two-level map: routerId -> Map<scopeKey, { scope, byBSSID }>
  const routers = new Map();

  files.forEach((f, fileIdx) => {
    if (!f || !f.data) return;
    const rid = routerId(f.data.run, f.data.radios);
    const displayHostname = f.data.run?.hostname || "unknown-router";
    const routerBssids = (f.data.radios || [])
      .filter((r) => r.bssid && !r.is_mlo)
      .map((r) => (r.bssid || "").toLowerCase())
      .filter(Boolean);
    if (!routers.has(rid)) {
      routers.set(rid, {
        id: rid,
        hostname: displayHostname,
        bssids: routerBssids,
        fileIdxs: [],
        fileLabels: [],
        scopes: new Map(),
      });
    }
    const router = routers.get(rid);
    if (!router.fileIdxs.includes(fileIdx)) {
      router.fileIdxs.push(fileIdx);
      router.fileLabels.push(f.label);
    }

    for (const m of f.data.metrics || []) {
      if (m.metric_id !== "neighbor_bss_list") continue;
      const skey = scopeKey(m.scope);
      if (!router.scopes.has(skey)) {
        router.scopes.set(skey, { scope: m.scope, byBSSID: new Map() });
      }
      const bucket = router.scopes.get(skey);
      for (const snap of m.samples || []) {
        const nbrs = snap.neighbors || [];
        for (const n of nbrs) {
          const bssid = (n.bssid || "").toLowerCase();
          if (!bssid) continue;
          let entry = bucket.byBSSID.get(bssid);
          if (!entry) {
            entry = {
              bssid,
              ssids: new Set(),
              channels: new Set(),
              widths: new Set(),
              signals: [],
              perFile: {}, // fileIdx -> count of snapshots this bssid appeared in
              qbss_util: [],
              qbss_stations: [],
            };
            bucket.byBSSID.set(bssid, entry);
          }
          if (n.ssid) entry.ssids.add(n.ssid);
          if (n.channel) entry.channels.add(n.channel);
          if (n.width_mhz) entry.widths.add(n.width_mhz);
          if (Number.isFinite(n.signal_dbm)) entry.signals.push(n.signal_dbm);
          if (typeof n.qbss_util_pct === "number")
            entry.qbss_util.push(n.qbss_util_pct);
          if (typeof n.qbss_stations === "number")
            entry.qbss_stations.push(n.qbss_stations);
          entry.perFile[fileIdx] = (entry.perFile[fileIdx] || 0) + 1;
        }
      }
    }
  });

  // Serialize to nested structure: [{ hostname, fileIdxs, fileLabels, scopes: [{scope, rows}] }]
  const result = [];
  for (const [, router] of routers) {
    const scopeGroups = [];
    for (const [, bucket] of router.scopes) {
      const rows = [];
      for (const [, e] of bucket.byBSSID) {
        const sMin = e.signals.length ? Math.min(...e.signals) : null;
        const sMax = e.signals.length ? Math.max(...e.signals) : null;
        const sMean = e.signals.length
          ? e.signals.reduce((a, b) => a + b, 0) / e.signals.length
          : null;
        rows.push({
          bssid: e.bssid,
          ssid: [...e.ssids].filter(Boolean).join(", ") || "(hidden)",
          channel: [...e.channels].sort((a, b) => a - b).join(","),
          width: [...e.widths].sort((a, b) => a - b).join(","),
          signalMin: sMin,
          signalMax: sMax,
          signalMean: sMean,
          perFile: e.perFile,
          qbssUtilMax: e.qbss_util.length ? Math.max(...e.qbss_util) : null,
          qbssStationsMax: e.qbss_stations.length
            ? Math.max(...e.qbss_stations)
            : null,
        });
      }
      rows.sort((a, b) => (b.signalMax ?? -999) - (a.signalMax ?? -999));
      scopeGroups.push({ scope: bucket.scope, rows });
    }
    scopeGroups.sort((a, b) =>
      (a.scope?.band || "").localeCompare(b.scope?.band || "")
    );
    result.push({
      id: router.id,
      hostname: router.hostname,
      bssids: router.bssids,
      fileIdxs: router.fileIdxs,
      fileLabels: router.fileLabels,
      scopes: scopeGroups,
    });
  }

  // Sort routers alphabetically by hostname for stable output.
  result.sort((a, b) => a.hostname.localeCompare(b.hostname));

  return result;
}

function NeighborDetail({ files, collapsed, onToggle }) {
  const grouped = useMemo(() => aggregateNeighbors(files), [files]);
  const [showAll, setShowAll] = useState({});

  if (!grouped.length || !grouped.some((r) => r.scopes.some((s) => s.rows.length)))
    return null;

  const multipleRouters = grouped.length > 1;

  return (
    <section style={{ marginBottom: 40 }}>
      <SectionHeader
        label="neighbor detail"
        title="Neighbors seen per band"
        hint={
          multipleRouters
            ? `grouped by router · ${grouped.length} routers detected`
            : "union across all files · sorted by strongest signal"
        }
        collapsible
        collapsed={collapsed}
        onToggle={onToggle}
      />
      {!collapsed && grouped.map((router) => {
        if (!router.scopes.some((s) => s.rows.length)) return null;
        return (
          <div key={router.id} style={{ marginBottom: 28 }}>
            {/* Router header — only shown when comparing across multiple routers */}
            {multipleRouters && (
              <div
                style={{
                  padding: "8px 14px",
                  marginBottom: 8,
                  background: COLORS.panel,
                  border: `1px solid ${COLORS.rule}`,
                  borderLeft: `3px solid ${COLORS.ink}`,
                  display: "flex",
                  alignItems: "baseline",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: COLORS.muted,
                    fontWeight: 600,
                  }}
                >
                  router
                </span>
                <span
                  style={{
                    fontFamily: FONT_SANS,
                    fontSize: 15,
                    fontWeight: 600,
                    color: COLORS.ink,
                  }}
                >
                  {router.hostname}
                </span>
                {router.bssids && router.bssids.length > 0 && (
                  <span
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 10,
                      color: COLORS.muted,
                    }}
                    title={router.bssids.join(", ")}
                  >
                    · bssid {router.bssids[0]}
                    {router.bssids.length > 1
                      ? ` (+${router.bssids.length - 1})`
                      : ""}
                  </span>
                )}
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 11,
                    color: COLORS.muted,
                  }}
                >
                  · from {router.fileIdxs
                    .map((i) => `F${i + 1}`)
                    .join(", ")}
                </span>
              </div>
            )}
            {router.scopes.map((g) => {
              if (!g.rows.length) return null;
              const skey = `${router.id}|${scopeKey(g.scope)}`;
              const expanded = !!showAll[skey];
              const LIMIT = 15;
              const displayRows = expanded ? g.rows : g.rows.slice(0, LIMIT);
              return (
                <div
                  key={skey}
                  style={{
                    marginBottom: 20,
                    background: COLORS.panel,
                    border: `1px solid ${COLORS.rule}`,
                  }}
                >
                  <div
                    style={{
                      padding: "10px 14px",
                      borderBottom: `1px solid ${COLORS.rule}`,
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                    }}
                  >
                    <div>
                      <span
                        style={{
                          fontFamily: FONT_SANS,
                          fontSize: 14,
                          fontWeight: 600,
                          color: COLORS.ink,
                        }}
                      >
                        {scopeLabel(g.scope)}
                      </span>
                      <span
                        style={{
                          fontFamily: FONT_MONO,
                          fontSize: 11,
                          color: COLORS.muted,
                          marginLeft: 10,
                        }}
                      >
                        {g.rows.length} unique BSSID
                        {g.rows.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  </div>
                  <div style={{ overflow: "auto" }}>
                    <table
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        fontFamily: FONT_MONO,
                        fontSize: 11,
                      }}
                    >
                      <thead>
                        <tr>
                          <NbHeaderCell align="left">bssid</NbHeaderCell>
                          <NbHeaderCell align="left">ssid</NbHeaderCell>
                          <NbHeaderCell align="right">ch</NbHeaderCell>
                          <NbHeaderCell align="right">width</NbHeaderCell>
                          <NbHeaderCell align="right">
                            RSSI signal (min · mean · max)
                          </NbHeaderCell>
                          <NbHeaderCell align="right">
                            qbss util (max)
                          </NbHeaderCell>
                          <NbHeaderCell align="right">
                            qbss sta (max)
                          </NbHeaderCell>
                          {router.fileIdxs.map((i) => (
                            <NbHeaderCell
                              key={i}
                              align="right"
                              color={FILE_COLORS[i]}
                            >
                              F{i + 1}
                            </NbHeaderCell>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {displayRows.map((r) => (
                          <tr key={r.bssid}>
                            <NbCell align="left" mono ink>
                              {r.bssid}
                            </NbCell>
                            <NbCell align="left">
                              {r.ssid || (
                                <span style={{ color: COLORS.muted }}>—</span>
                              )}
                            </NbCell>
                            <NbCell align="right">{r.channel || "—"}</NbCell>
                            <NbCell align="right">
                              {r.width ? `${r.width} MHz` : "—"}
                            </NbCell>
                            <NbCell align="right">
                              {r.signalMin != null
                                ? `${r.signalMin} · ${r.signalMean.toFixed(0)} · ${r.signalMax}`
                                : "—"}
                            </NbCell>
                            <NbCell align="right">
                              {r.qbssUtilMax != null
                                ? `${r.qbssUtilMax}%`
                                : "—"}
                            </NbCell>
                            <NbCell align="right">
                              {r.qbssStationsMax != null
                                ? r.qbssStationsMax
                                : "—"}
                            </NbCell>
                            {router.fileIdxs.map((i) => {
                              const cnt = r.perFile[i] || 0;
                              return (
                                <NbCell key={i} align="right">
                                  {cnt > 0 ? (
                                    <span
                                      style={{
                                        color: FILE_COLORS[i],
                                        fontWeight: 600,
                                      }}
                                    >
                                      {cnt}
                                    </span>
                                  ) : (
                                    <span style={{ color: COLORS.rule }}>
                                      —
                                    </span>
                                  )}
                                </NbCell>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {g.rows.length > LIMIT && (
                    <div
                      style={{
                        padding: "8px 14px",
                        borderTop: `1px solid ${COLORS.rule}`,
                        textAlign: "center",
                      }}
                    >
                      <button
                        onClick={() =>
                          setShowAll({ ...showAll, [skey]: !expanded })
                        }
                        style={{
                          background: "transparent",
                          border: "none",
                          color: COLORS.muted,
                          cursor: "pointer",
                          fontFamily: FONT_MONO,
                          fontSize: 11,
                          padding: "2px 12px",
                        }}
                      >
                        {expanded
                          ? `show fewer (top ${LIMIT})`
                          : `show all ${g.rows.length}`}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}

function NbHeaderCell({ children, align, color }) {
  return (
    <th
      style={{
        textAlign: align,
        padding: "8px 12px",
        fontSize: 10,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: color || COLORS.muted,
        fontWeight: 600,
        borderBottom: `1px solid ${COLORS.rule}`,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

function NbCell({ children, align, mono, ink }) {
  return (
    <td
      style={{
        textAlign: align,
        padding: "5px 12px",
        borderBottom: `1px solid ${COLORS.rule}`,
        fontFamily: mono !== false ? FONT_MONO : FONT_SANS,
        color: ink ? COLORS.ink : COLORS.muted,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </td>
  );
}

// ---------- per-band client comparison ----------

// Per-station metrics that are meaningful to compare across clients on
// the same band. Everything the per_station_* family emits.
const PER_STATION_METRICS = [
  "per_station_rssi",
  "per_station_rssi_avg",
  "per_station_phy_rate_tx",
  "per_station_phy_rate_rx",
  "per_station_tx_bytes",
  "per_station_tx_packets",
  "per_station_rx_bytes",
  "per_station_rx_packets",
  "per_station_tx_retries",
  "per_station_tx_failed",
  "per_station_rx_drops",
  "per_station_connected_time",
  "per_station_inactive_time",
];

// Palette for identifying clients in comparison charts. Deliberately
// distinct from FILE_COLORS so the two dimensions don't visually collide.
const CLIENT_COLORS = [
  "#B45309", // amber
  "#15803D", // green
  "#DC2626", // red
  "#0891B2", // cyan
  "#DB2777", // pink
  "#7C3AED", // purple
  "#4D7C0F", // olive
  "#A16207", // dark yellow
];

// Line dash patterns to differentiate files in the same chart.
// Recharts strokeDasharray syntax: "dash space" pairs.
const FILE_DASH_PATTERNS = ["", "5 3", "2 2", "5 2 1 2"];
const FILE_DASH_LABELS = ["solid", "dashed", "dotted", "dash-dot"];

// aggregateClientComparisons walks all files' per-station metrics and
// groups by (metric_id, band). For each group, it collects one series per
// (file, client) combination. Groups with only one client across all files
// are dropped — no comparison to make.
function aggregateClientComparisons(files, clientFilter) {
  const groups = new Map(); // "metric|band" -> group

  files.forEach((f, fileIdx) => {
    if (!f || !f.data) return;
    for (const m of f.data.metrics || []) {
      if (!PER_STATION_METRICS.includes(m.metric_id)) continue;
      const band = m.scope?.band;
      const mac = m.scope?.client_mac;
      if (!band || !mac) continue;
      if (clientFilter[mac] === false) continue;

      const key = `${m.metric_id}|${band}`;
      if (!groups.has(key)) {
        groups.set(key, {
          metricId: m.metric_id,
          band,
          unit: m.unit,
          valueType: m.value_type,
          aggregationHint: m.aggregation_hint,
          series: [],
        });
      }

      const client = f.data.clients_seen?.find((c) => c.mac === mac);
      const hostname = client?.hostname || mac.slice(-8);

      groups.get(key).series.push({
        fileIdx,
        fileLabel: f.label,
        clientMac: mac,
        hostname,
        metric: m,
        runStart: f.data.run.start_time,
      });
    }
  });

  // Only keep groups where at least 2 distinct clients are present.
  const result = [];
  for (const g of groups.values()) {
    const uniqueClients = new Set(g.series.map((s) => s.clientMac));
    if (uniqueClients.size < 2) continue;
    // Assign a color to each client, stable across the group.
    const clientColors = new Map();
    const orderedClients = Array.from(uniqueClients);
    orderedClients.forEach((mac, i) => {
      clientColors.set(mac, CLIENT_COLORS[i % CLIENT_COLORS.length]);
    });
    g.clientColors = clientColors;
    result.push(g);
  }

  // Sort by metric ID (following canonical order), then band.
  const metricOrder = new Map(
    PER_STATION_METRICS.map((m, i) => [m, i])
  );
  result.sort((a, b) => {
    const oa = metricOrder.get(a.metricId) ?? 999;
    const ob = metricOrder.get(b.metricId) ?? 999;
    if (oa !== ob) return oa - ob;
    return a.band.localeCompare(b.band);
  });
  return result;
}

function ClientComparisonSection({ files, clientFilter, collapsed, onToggle }) {
  const groups = useMemo(
    () => aggregateClientComparisons(files, clientFilter),
    [files, clientFilter]
  );
  const loadedFiles = files
    .map((f, i) => ({ f, i }))
    .filter((x) => x.f && x.f.data);

  const showFileLegend = loadedFiles.length > 1;
  const hasData = groups.length > 0;

  return (
    <section style={{ marginBottom: 40 }}>
      <SectionHeader
        label="client-vs-client comparison"
        title="Client-vs-client comparison"
        hint={
          hasData
            ? `${groups.length} chart${groups.length === 1 ? "" : "s"} · color = client · ${showFileLegend ? "dash = file" : "single file"}`
            : "no comparisons available"
        }
        collapsible
        collapsed={collapsed}
        onToggle={onToggle}
      />
      {!collapsed && (
        hasData ? (
          groups.map((g) => (
            <ClientComparisonCard
              key={`${g.metricId}|${g.band}`}
              group={g}
              showFileLegend={showFileLegend}
            />
          ))
        ) : (
          <div
            style={{
              padding: "16px 18px",
              background: COLORS.panel,
              border: `1px solid ${COLORS.rule}`,
              fontFamily: FONT_MONO,
              fontSize: 11,
              color: COLORS.muted,
              lineHeight: 1.5,
            }}
          >
            No comparison data available. This view renders one chart per
            per-station metric per band, but requires at least 2 distinct
            clients on the same band across the loaded files. Currently{" "}
            {loadedFiles.length === 0
              ? "no files are loaded."
              : "only one client per band is present."}
          </div>
        )
      )}
    </section>
  );
}

function ClientComparisonCard({ group, showFileLegend }) {
  const chartData = useMemo(() => {
    const rows = new Map();
    for (const s of group.series) {
      for (const sample of s.metric.samples || []) {
        const tRel = toRelativeSec(sample.t, s.runStart);
        if (tRel == null) continue;
        const v = extractSampleValue(sample, s.metric.value_type);
        if (v == null || !Number.isFinite(v)) continue;
        if (!rows.has(tRel)) rows.set(tRel, { t_rel: tRel });
        rows.get(tRel)[`f${s.fileIdx}_${s.clientMac}`] = v;
      }
    }
    return Array.from(rows.values()).sort((a, b) => a.t_rel - b.t_rel);
  }, [group]);

  return (
    <div
      style={{
        background: COLORS.panel,
        border: `1px solid ${COLORS.rule}`,
        padding: "16px 18px",
        marginBottom: 12,
      }}
    >
      <div style={{ marginBottom: 10 }}>
        <div
          style={{
            fontFamily: FONT_SANS,
            fontSize: 15,
            fontWeight: 600,
            color: COLORS.ink,
          }}
        >
          {group.metricId}
          <span
            style={{
              marginLeft: 8,
              fontFamily: FONT_MONO,
              fontSize: 11,
              color: COLORS.muted,
              fontWeight: 400,
            }}
          >
            ({group.unit})
          </span>
        </div>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            color: COLORS.muted,
            marginTop: 2,
          }}
        >
          {group.band} · {group.series.length} series ·{" "}
          {group.clientColors.size} client{group.clientColors.size === 1 ? "" : "s"}
          {" · "}
          {group.valueType} · {group.aggregationHint}
        </div>
      </div>

      {/* Chart */}
      {chartData.length > 1 ? (
        <div style={{ height: 180 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartData}
              margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
            >
              <CartesianGrid
                stroke={COLORS.rule}
                strokeDasharray="2 4"
                vertical={false}
              />
              <XAxis
                dataKey="t_rel"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(t) => `${t}s`}
                stroke={COLORS.muted}
                tick={{
                  fontSize: 9,
                  fontFamily: FONT_MONO,
                  fill: COLORS.muted,
                }}
                axisLine={{ stroke: COLORS.rule }}
                tickLine={{ stroke: COLORS.rule }}
              />
              <YAxis
                stroke={COLORS.muted}
                tick={{
                  fontSize: 9,
                  fontFamily: FONT_MONO,
                  fill: COLORS.muted,
                }}
                axisLine={{ stroke: COLORS.rule }}
                tickLine={{ stroke: COLORS.rule }}
                width={48}
              />
              <Tooltip
                contentStyle={{
                  background: COLORS.panel,
                  border: `1px solid ${COLORS.rule}`,
                  borderRadius: 2,
                  fontFamily: FONT_MONO,
                  fontSize: 10,
                  padding: "6px 10px",
                }}
                labelFormatter={(t) => `t = ${t}s`}
                formatter={(value, name) => {
                  // name is "f<idx>_<mac>". Look up the series.
                  const s = group.series.find(
                    (x) => `f${x.fileIdx}_${x.clientMac}` === name
                  );
                  if (!s) return [fmt(value, group.unit), name];
                  const fileTag = showFileLegend ? ` [${s.fileLabel}]` : "";
                  return [fmt(value, group.unit), `${s.hostname}${fileTag}`];
                }}
              />
              {group.series.map((s) => (
                <Line
                  key={`f${s.fileIdx}_${s.clientMac}`}
                  type="monotone"
                  dataKey={`f${s.fileIdx}_${s.clientMac}`}
                  stroke={group.clientColors.get(s.clientMac)}
                  strokeWidth={1.4}
                  strokeDasharray={FILE_DASH_PATTERNS[s.fileIdx] || ""}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div
          style={{
            padding: "16px 0",
            textAlign: "center",
            fontFamily: FONT_MONO,
            fontSize: 11,
            color: COLORS.muted,
          }}
        >
          not enough sample points to chart
        </div>
      )}

      {/* Legend */}
      <div
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: `1px solid ${COLORS.rule}`,
          display: "flex",
          flexWrap: "wrap",
          gap: "6px 16px",
          fontFamily: FONT_MONO,
          fontSize: 10,
        }}
      >
        {group.series.map((s) => (
          <div
            key={`f${s.fileIdx}_${s.clientMac}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: COLORS.muted,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 24,
                height: 0,
                borderTop: `2px ${
                  FILE_DASH_PATTERNS[s.fileIdx] ? "dashed" : "solid"
                } ${group.clientColors.get(s.clientMac)}`,
              }}
            />
            <span style={{ color: COLORS.ink }}>{s.hostname}</span>
            {showFileLegend && (
              <span style={{ opacity: 0.7 }}>· {s.fileLabel}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- main app ----------

export default function FlintExplorer() {
  const [files, setFiles] = useState([null, null, null, null]);
  const [showOnlyWithData, setShowOnlyWithData] = useState(true);
  const [importanceFilter, setImportanceFilter] = useState({
    critical: true,
    important: true,
    optional: true,
  });
  const [bandFilter, setBandFilter] = useState({
    "2.4GHz": true,
    "5GHz": true,
    "6GHz": true,
    global: true,
  });
  // clientFilter is an object keyed by MAC. Absence or `true` = shown;
  // `false` = hidden. Unknown MACs default to shown when checked.
  const [clientFilter, setClientFilter] = useState({});
  const [search, setSearch] = useState("");
  // collapsedSections: { [sectionName]: bool } — true means the section body
  // is hidden while its header stays visible. Independent from the section
  // filters, which decide whether a section renders at all. Default: all
  // collapsible sections start collapsed (user expands what they want).
  const [collapsedSections, setCollapsedSections] = useState({
    "Airtime & Congestion": true,
    "Client Link Health": true,
    "Neighbor Scan": true,
    "Neighbors seen per band": true,
    "Errors (optional)": true,
    Universal: true,
    "Other metrics": true,
    "Client-vs-client comparison": true,
  });
  const toggleSection = useCallback((name) => {
    setCollapsedSections((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);
  // Whether the Client-vs-client comparison section renders at all.
  // Default off — user opts in when they want to see the aggregate view.
  const [showClientComparison, setShowClientComparison] = useState(false);

  const onLoad = useCallback((slot, file) => {
    setFiles((prev) => {
      const next = [...prev];
      next[slot] = file;
      return next;
    });
  }, []);
  const onRemove = useCallback((slot) => {
    setFiles((prev) => {
      const next = [...prev];
      next[slot] = null;
      return next;
    });
  }, []);
  const onRename = useCallback((slot, label) => {
    setFiles((prev) => {
      const next = [...prev];
      if (next[slot]) next[slot] = { ...next[slot], label };
      return next;
    });
  }, []);

  // Enumerate unique (metric_id, scope) tuples across all loaded files.
  const { metricMeta, metricKeysAll } = useMemo(() => {
    const meta = {};
    for (const f of files) {
      if (!f || !f.data) continue;
      for (const m of f.data.metrics || []) {
        const key = m.metric_id + "|" + scopeKey(m.scope);
        if (!meta[key]) {
          meta[key] = {
            metric_id: m.metric_id,
            scope: m.scope,
            importance: m.importance,
            unit: m.unit,
            value_type: m.value_type,
            aggregation_hint: m.aggregation_hint,
            notes: m.notes,
          };
        }
      }
    }
    const keys = Object.keys(meta);
    const groupOrder = new Map();
    METRIC_GROUPS.forEach((g, gi) =>
      g.metrics.forEach((m) => groupOrder.set(m, gi))
    );
    keys.sort((a, b) => {
      const ma = meta[a],
        mb = meta[b];
      const ga = groupOrder.get(ma.metric_id) ?? 999;
      const gb = groupOrder.get(mb.metric_id) ?? 999;
      if (ga !== gb) return ga - gb;
      if (ma.metric_id !== mb.metric_id)
        return ma.metric_id.localeCompare(mb.metric_id);
      return scopeKey(ma.scope).localeCompare(scopeKey(mb.scope));
    });
    return { metricMeta: meta, metricKeysAll: keys };
  }, [files]);

  // Enumerate unique clients across all loaded files. Each entry gets a
  // display label (hostname if known, else short-MAC), the band it was
  // associated on, and which files it appeared in.
  const knownClients = useMemo(() => {
    const byMac = new Map();
    files.forEach((f, i) => {
      if (!f || !f.data) return;
      for (const c of f.data.clients_seen || []) {
        if (!byMac.has(c.mac)) {
          const shortMac = c.mac.slice(-8);
          const label = c.hostname
            ? `${c.hostname} · ${c.band || "—"}`
            : `${shortMac} · ${c.band || "—"}`;
          byMac.set(c.mac, {
            mac: c.mac,
            hostname: c.hostname || "",
            band: c.band,
            label,
            fileIdxs: [],
          });
        }
        byMac.get(c.mac).fileIdxs.push(i);
      }
    });
    return Array.from(byMac.values()).sort((a, b) =>
      a.label.localeCompare(b.label)
    );
  }, [files]);

  // Apply filters (importance, band, client, search) — but NOT the
  // empty-data filter, since that also depends on file data and is
  // applied per-card.
  const filteredKeys = useMemo(() => {
    const q = search.trim().toLowerCase();
    return metricKeysAll.filter((k) => {
      const meta = metricMeta[k];
      if (!importanceFilter[meta.importance]) return false;
      if (!bandFilter[metricBand(meta)]) return false;
      // Client filter: only applies to metrics scoped to a specific client.
      // Radio-level and global metrics (no scope.client_mac) always pass.
      const cm = meta.scope?.client_mac;
      if (cm && clientFilter[cm] === false) return false;
      if (q) {
        const hay = (
          meta.metric_id +
          " " +
          scopeLabel(meta.scope) +
          " " +
          meta.importance +
          " " +
          (meta.unit || "")
        ).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [metricKeysAll, metricMeta, importanceFilter, bandFilter, clientFilter, search]);

  // Count metrics that will actually render (respecting hide-empty).
  const visibleCount = useMemo(() => {
    if (!showOnlyWithData) return filteredKeys.length;
    return filteredKeys.filter((k) => {
      const meta = metricMeta[k];
      for (const f of files) {
        if (!f || !f.data) continue;
        const metric = getMetric(f.data, meta.metric_id, meta.scope);
        if (metric && extractSeries(metric).length > 0) return true;
      }
      return false;
    }).length;
  }, [filteredKeys, metricMeta, files, showOnlyWithData]);

  const loadedCount = files.filter((f) => f && f.data).length;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: COLORS.bg,
        color: COLORS.ink,
        fontFamily: FONT_SANS,
        padding: "32px 24px 64px",
      }}
    >
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <header style={{ marginBottom: 32 }}>
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 11,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: COLORS.muted,
              marginBottom: 6,
            }}
          >
            flint3.metrics / explorer
          </div>
          <h1
            style={{
              fontSize: 34,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              margin: 0,
              lineHeight: 1.05,
            }}
          >
            Sample explorer
          </h1>
          <p
            style={{
              fontSize: 14,
              color: COLORS.muted,
              lineHeight: 1.55,
              marginTop: 10,
              maxWidth: 720,
            }}
          >
            Drop JSON files from{" "}
            <code style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              flint3-probe
            </code>{" "}
            into the slots below. Each metric is summarized with the stats
            appropriate to its aggregation hint, and charted with all loaded
            files overlaid on a shared relative-time axis.
          </p>
        </header>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 12,
            marginBottom: 28,
          }}
        >
          {files.map((f, i) => (
            <FileSlot
              key={i}
              slot={i}
              file={f}
              color={FILE_COLORS[i]}
              onLoad={onLoad}
              onRemove={onRemove}
              onRename={onRename}
            />
          ))}
        </section>

        {loadedCount === 0 && (
          <div
            style={{
              padding: 24,
              background: COLORS.panel,
              border: `1px solid ${COLORS.rule}`,
              fontFamily: FONT_MONO,
              fontSize: 12,
              color: COLORS.muted,
              textAlign: "center",
            }}
          >
            No files loaded yet. Drop a{" "}
            <code style={{ fontFamily: FONT_MONO }}>flint3_probe_*.json</code>{" "}
            into one of the slots above to begin.
          </div>
        )}

        {loadedCount > 0 && (
          <>
            <OverviewStrip files={files} />

            <CoverageMatrix
              files={files}
              metricKeys={filteredKeys}
              metricMeta={metricMeta}
            />

            <FilterBar
              showOnlyWithData={showOnlyWithData}
              setShowOnlyWithData={setShowOnlyWithData}
              importanceFilter={importanceFilter}
              setImportanceFilter={setImportanceFilter}
              bandFilter={bandFilter}
              setBandFilter={setBandFilter}
              clientFilter={clientFilter}
              setClientFilter={setClientFilter}
              knownClients={knownClients}
              showClientComparison={showClientComparison}
              setShowClientComparison={setShowClientComparison}
              search={search}
              setSearch={setSearch}
              visibleCount={visibleCount}
              totalCount={metricKeysAll.length}
            />

            {METRIC_GROUPS.map((group) => {
              const groupKeys = filteredKeys.filter((k) =>
                group.metrics.includes(metricMeta[k].metric_id)
              );
              if (groupKeys.length === 0) return null;
              const isNeighborGroup = group.name === "Neighbor Scan";
              const groupCollapsed = !!collapsedSections[group.name];
              return (
                <React.Fragment key={group.name}>
                  <section style={{ marginBottom: 40 }}>
                    <SectionHeader
                      label={group.name.toLowerCase()}
                      title={group.name}
                      collapsible
                      collapsed={groupCollapsed}
                      onToggle={() => toggleSection(group.name)}
                    />
                    {!groupCollapsed &&
                      groupKeys.map((key) => (
                        <MetricCard
                          key={key}
                          meta={metricMeta[key]}
                          files={files}
                          showOnlyWithData={showOnlyWithData}
                        />
                      ))}
                  </section>
                  {isNeighborGroup && (
                    <NeighborDetail
                      files={files}
                      collapsed={
                        !!collapsedSections["Neighbors seen per band"]
                      }
                      onToggle={() =>
                        toggleSection("Neighbors seen per band")
                      }
                    />
                  )}
                </React.Fragment>
              );
            })}

            {showClientComparison && (
              <ClientComparisonSection
                files={files}
                clientFilter={clientFilter}
                collapsed={
                  !!collapsedSections["Client-vs-client comparison"]
                }
                onToggle={() =>
                  toggleSection("Client-vs-client comparison")
                }
              />
            )}

            {(() => {
              const known = new Set();
              METRIC_GROUPS.forEach((g) =>
                g.metrics.forEach((m) => known.add(m))
              );
              const otherKeys = filteredKeys.filter(
                (k) => !known.has(metricMeta[k].metric_id)
              );
              if (!otherKeys.length) return null;
              const otherCollapsed = !!collapsedSections["Other metrics"];
              return (
                <section style={{ marginBottom: 40 }}>
                  <SectionHeader
                    label="other"
                    title="Other metrics"
                    collapsible
                    collapsed={otherCollapsed}
                    onToggle={() => toggleSection("Other metrics")}
                  />
                  {!otherCollapsed &&
                    otherKeys.map((key) => (
                      <MetricCard
                        key={key}
                        meta={metricMeta[key]}
                        files={files}
                        showOnlyWithData={showOnlyWithData}
                      />
                    ))}
                </section>
              );
            })()}
          </>
        )}

        <footer
          style={{
            marginTop: 40,
            paddingTop: 20,
            borderTop: `1px solid ${COLORS.rule}`,
            fontFamily: FONT_MONO,
            fontSize: 10,
            letterSpacing: "0.06em",
            color: COLORS.muted,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
        </footer>
      </div>
    </div>
  );
}
