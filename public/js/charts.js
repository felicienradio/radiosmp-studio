/* global Chart */
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function theme() {
  return {
    text: css('--text-2'),
    grid: css('--border'),
    c: [1, 2, 3, 4, 5, 6].map((i) => css(`--c${i}`)),
    panel: css('--panel'),
  };
}

function alpha(color, a) {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return color;
}

const charts = new WeakMap();

const MIN = 60_000;
const STEPS = [MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, 60 * MIN, 2 * 3600_000, 3 * 3600_000, 6 * 3600_000,
  12 * 3600_000, 86400_000, 2 * 86400_000, 7 * 86400_000, 14 * 86400_000, 30 * 86400_000];

/** Pas de graduation « rond » (1 min, 15 min, 1 h, 6 h, 1 j…) pour ~7 graduations. */
function timeStep(span) {
  return STEPS.find((s) => span / s <= 8) || STEPS.at(-1);
}

export function destroyCharts(root) {
  root.querySelectorAll('canvas').forEach((c) => charts.get(c)?.destroy());
}

/**
 * Courbe temporelle. series : [{ label, data: [{x, y}], color?, fill?, dashed? }]
 */
export function lineChart(canvas, series, { unit = 'auditeurs', timeFormat = 'time', stepped = false, min, max } = {}) {
  charts.get(canvas)?.destroy();
  const t = theme();
  const fmtX = timeFormat === 'day'
    ? (v) => new Date(v).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
    : timeFormat === 'dayhour'
      ? (v) => new Date(v).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
      : (v) => new Date(v).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const xs = series.flatMap((s) => s.data.map((p) => p.x));
  const span = (max ?? Math.max(...xs, 0)) - (min ?? Math.min(...xs, 0));
  const step = timeStep(span || 3600_000);
  const off = step >= 86400_000 ? 0 : -new Date().getTimezoneOffset() * MIN;
  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: series.map((s, i) => {
        const color = s.color || t.c[i % t.c.length];
        return {
          label: s.label,
          data: s.data,
          borderColor: color,
          backgroundColor: s.fill === false ? 'transparent' : alpha(color, 0.14),
          fill: s.fill !== false,
          borderWidth: 2,
          borderDash: s.dashed ? [5, 4] : [],
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.25,
          stepped,
        };
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          type: 'linear',
          min,
          max,
          afterBuildTicks: (axis) => {
            // graduations alignées sur des heures/minutes rondes (heure locale)
            const ticks = [];
            for (let v = Math.ceil((axis.min + off) / step) * step - off; v <= axis.max; v += step) ticks.push({ value: v });
            axis.ticks = ticks;
          },
          ticks: { color: t.text, callback: fmtX, maxRotation: 0 },
          grid: { color: t.grid, drawTicks: false },
          border: { display: false },
        },
        y: {
          beginAtZero: true,
          ticks: { color: t.text, precision: 0, maxTicksLimit: 6 },
          grid: { color: t.grid, drawTicks: false },
          border: { display: false },
        },
      },
      plugins: {
        legend: { display: series.length > 1, labels: { color: t.text, boxWidth: 12, boxHeight: 3 } },
        tooltip: {
          callbacks: {
            title: (items) => new Date(items[0].parsed.x).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }),
            label: (item) => ` ${item.dataset.label} : ${item.parsed.y.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${unit}`,
          },
        },
      },
    },
  });
  charts.set(canvas, chart);
  return chart;
}

export function doughnutChart(canvas, labels, values) {
  charts.get(canvas)?.destroy();
  const t = theme();
  const chart = new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: labels.map((_, i) => t.c[i % t.c.length]), borderColor: t.panel, borderWidth: 2 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: { legend: { position: 'right', labels: { color: t.text, boxWidth: 10, padding: 10 } } },
    },
  });
  charts.set(canvas, chart);
  return chart;
}

export function barChart(canvas, labels, values, { label = 'Sessions' } = {}) {
  charts.get(canvas)?.destroy();
  const t = theme();
  const chart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label, data: values, backgroundColor: alpha(t.c[1], 0.8), borderRadius: 5 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: t.text }, grid: { display: false }, border: { display: false } },
        y: { beginAtZero: true, ticks: { color: t.text, precision: 0 }, grid: { color: t.grid }, border: { display: false } },
      },
      plugins: { legend: { display: false } },
    },
  });
  charts.set(canvas, chart);
  return chart;
}
