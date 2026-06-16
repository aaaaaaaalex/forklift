// flui V2 — interactive node-graph over the Forklift inventory snapshot.
// Source environments (vSphere/etc): VM -> NIC -> Network.
// Destination environment (OpenShift + Calico): NAD -> Calico Network -> IPPool.
// Click a node to see all its fields and any correlated errors.
import {
  DEST_TYPES,
  calicoNads,
  concernCounts,
  destElements,
  findCalicoNetworkByVlan,
  liveMigrationElements,
  migrationPhase,
  planElements,
  sevClass,
  sortErrors,
  sourceElements,
  vlanIdToNumber,
  vmProgress,
} from "./graph.js";
import type {
  ErrorItem,
  GraphElement,
  GraphNodeData,
  Plan,
  PlanStatus,
  PlanVMStatus,
  Provider,
  Snapshot,
} from "./types.js";

let lastSnapshot: Snapshot | null = null;
let activeKey: string | null = null; // "src:<uid>" | "dst" | "plan:<ns>/<name>"
let cy: CyCore | null = null;
let openPlanKey: string | null = null; // set while a plan's progress pane is open

// ---- tiny DOM helpers ----
type Child = Node | string | null | undefined;

function el(tag: string, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = String(v);
    else if (k === "onclick") e.onclick = v as (this: GlobalEventHandlers, ev: MouseEvent) => unknown;
    else if (v !== null && v !== undefined) e.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function setStatus(text: string, cls?: string): void {
  const s = byId("status");
  s.textContent = text;
  s.className = "status" + (cls ? " " + cls : "");
}

// ====================================================================
// Data fetching
// ====================================================================
async function fetchData(url: string, btn?: HTMLButtonElement): Promise<void> {
  setStatus("fetching…");
  if (btn) {
    btn.disabled = true;
    btn.dataset.label = btn.textContent ?? "";
    btn.innerHTML = '<span class="spin">↻</span> working…';
  }
  try {
    const resp = await fetch(url, { cache: "no-store" });
    lastSnapshot = (await resp.json()) as Snapshot;
    render(lastSnapshot);
  } catch (err) {
    setStatus("error: " + err, "bad");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.label ?? "";
    }
  }
}

function render(snap: Snapshot): void {
  setStatus(snap.ok ? "live" : "inventory unreachable", snap.ok ? "ok" : "bad");
  renderFooter(snap);
  buildSidebar(snap);

  const keys = envKeys(snap);
  if (!activeKey || !keys.includes(activeKey)) activeKey = keys[0] ?? null;
  renderActive(snap);
}

function renderFooter(snap: Snapshot): void {
  const when = snap.fetchedAt ? new Date(snap.fetchedAt).toLocaleString() : "never";
  byId("meta").textContent =
    `inventory: ${snap.inventoryUrl || "?"} · snapshot ${when} · crawl ${snap.durationMs ?? "?"}ms`;
}

// ====================================================================
// Sidebar
// ====================================================================
function sourceProviders(snap: Snapshot): Provider[] {
  return (snap.providers ?? []).filter((p) => !DEST_TYPES.has(p.type));
}
function hasDestination(snap: Snapshot): boolean {
  return (snap.providers ?? []).some((p) => DEST_TYPES.has(p.type)) || !!snap.calico;
}
function planKey(pl: { namespace?: string; name: string }): string {
  return `plan:${pl.namespace}/${pl.name}`;
}
function lmKey(lm: { namespace: string; name: string }): string {
  return `lm:${lm.namespace}/${lm.name}`;
}
function envKeys(snap: Snapshot): string[] {
  const keys = sourceProviders(snap).map((p) => "src:" + p.uid);
  if (hasDestination(snap)) keys.push("dst");
  for (const pl of snap.plans ?? []) keys.push(planKey(pl));
  for (const lm of snap.liveMigrations ?? []) keys.push(lmKey(lm));
  return keys;
}

function buildSidebar(snap: Snapshot): void {
  const root = byId("sidebar");
  const items: HTMLElement[] = [];

  const srcs = sourceProviders(snap);
  if (srcs.length) {
    items.push(el("div", { class: "group" }, "Source environments"));
    for (const p of srcs) {
      const key = "src:" + p.uid;
      const hasErr = (p.resources?.vms ?? []).some((vm) => concernCounts(vm).Critical > 0);
      items.push(sidebarItem(key, "src", p.name || "(unnamed)", p.type, hasErr, snap));
    }
  }
  if (hasDestination(snap)) {
    items.push(el("div", { class: "group" }, "Destination environment"));
    const calicoErr =
      (!!snap.calico && (snap.calico.networks ?? []).some((n) => (n.errors ?? []).length > 0)) ||
      calicoNads(snap).some(
        (n) => !!n.network && !!snap.calico && !(snap.calico.networks ?? []).some((x) => x.name === n.network),
      );
    items.push(sidebarItem("dst", "dst", "OpenShift / Calico", "destination", calicoErr, snap));
  }
  if ((snap.plans ?? []).length || snap.plansError) {
    items.push(el("div", { class: "group" }, "Migration plans"));
    if (snap.plansError && (snap.plans ?? []).length === 0) {
      items.push(
        el("div", { class: "item plan-err" }, el("div", {}, el("div", { class: "sub err" }, "⚠ " + snap.plansError))),
      );
    }
    for (const pl of snap.plans ?? []) {
      const ids = new Set((pl.vms ?? []).map((v) => v.id).filter(Boolean));
      const names = new Set((pl.vms ?? []).map((v) => v.name).filter(Boolean));
      const hasErr = sourceProviders(snap).some((p) =>
        (p.resources?.vms ?? []).some((vm) => (ids.has(vm.id) || names.has(vm.name)) && concernCounts(vm).Critical > 0),
      );
      items.push(sidebarItem(planKey(pl), "plan", pl.name, `plan · ${pl.vms?.length ?? 0} VM(s)`, hasErr, snap));
    }
  }
  if ((snap.liveMigrations ?? []).length) {
    items.push(el("div", { class: "group" }, "Live Migrations"));
    for (const lm of snap.liveMigrations ?? []) {
      items.push(sidebarItem(lmKey(lm), "lm", lm.name, `${lm.vmiName} · ${lm.phase ?? "?"}`, !!lm.failed, snap));
    }
  }

  if (items.length === 0) items.push(el("div", { class: "group" }, "No environments found"));
  root.replaceChildren(...items);
}

function sidebarItem(
  key: string,
  kind: string,
  name: string,
  sub: string,
  hasErr: boolean,
  snap: Snapshot,
): HTMLElement {
  const item = el(
    "div",
    { class: "item " + kind + (key === activeKey ? " active" : "") + (hasErr ? " err-badge" : "") },
    el("span", { class: "dot" }),
    el("div", {}, el("div", { class: "nm" }, name), el("div", { class: "sub" }, sub)),
  );
  item.onclick = () => {
    activeKey = key;
    clearDetail();
    buildSidebar(snap);
    renderActive(snap);
  };
  return item;
}

// ====================================================================
// Graph rendering
// ====================================================================
function renderActive(snap: Snapshot): void {
  let elements: GraphElement[] = [];
  let activePlan: Plan | undefined;
  if (activeKey && activeKey.startsWith("src:")) {
    const uid = activeKey.slice(4);
    const p = (snap.providers ?? []).find((x) => x.uid === uid);
    if (p) elements = sourceElements(p);
  } else if (activeKey === "dst") {
    elements = destElements(snap);
  } else if (activeKey && activeKey.startsWith("plan:")) {
    activePlan = (snap.plans ?? []).find((x) => planKey(x) === activeKey);
    if (activePlan) elements = planElements(snap, activePlan);
  } else if (activeKey && activeKey.startsWith("lm:")) {
    const lm = (snap.liveMigrations ?? []).find((x) => lmKey(x) === activeKey);
    if (lm) elements = liveMigrationElements(lm);
  }
  renderGraph(elements);

  // Selecting a migration plan opens its progress pane straight away (no need to
  // hunt for the Plan node), and highlights the node in the graph.
  if (activePlan) {
    renderPlanDetail(activePlan);
    const node = cy?.getElementById(planKey(activePlan));
    if (node && !node.empty()) node.select();
  }
}

// Largest zoom used for the initial fit, so a few-node graph isn't blown up.
const INITIAL_ZOOM_CAP = 1.2;

function clampInitialZoom(max: number): void {
  if (cy && cy.zoom() > max) {
    cy.zoom(max);
    cy.center();
  }
}

function renderGraph(elements: GraphElement[]): void {
  const container = byId("cy");
  if (cy) {
    cy.destroy();
    cy = null;
  }
  if (!elements.length) {
    container.replaceChildren(el("div", { class: "empty" }, "No nodes for this environment."));
    return;
  }
  container.replaceChildren(); // cytoscape takes over the container

  cy = cytoscape({
    container,
    elements,
    style: graphStyle(),
    layout: currentLayout(),
    wheelSensitivity: 0.2,
    minZoom: 0.2,
    maxZoom: 2.5,
  });

  // The layout fits the graph to the viewport, which blows up small graphs.
  // Cap the *initial* zoom so nodes render at a natural size; the user can
  // still zoom in further by hand (up to maxZoom).
  clampInitialZoom(INITIAL_ZOOM_CAP);
  cy.one("layoutstop", () => clampInitialZoom(INITIAL_ZOOM_CAP));

  cy.on("tap", "node", (evt: CyEvent) => showDetail(evt.target as CyNode));
  cy.on("tap", (evt: CyEvent) => {
    if (evt.target === cy) clearDetail();
  });

  // Read-only debug hook: expose the active graph instance on window so it can
  // be inspected from the console / automation (e.g. window.__cy.nodes()).
  (window as unknown as { __cy?: CyCore }).__cy = cy;
}

function currentLayout(): Record<string, unknown> {
  const name = byId<HTMLSelectElement>("layout").value || "dagre";
  const base = { name, padding: 24, animate: false, fit: true };
  if (name === "dagre")
    // Left-to-right hierarchy. rankSep is the gap between layers (kept small so
    // NICs sit close to their VMs); nodeSep is the gap between siblings.
    return { ...base, rankDir: "LR", rankSep: 55, nodeSep: 18, edgeSep: 6, ranker: "tight-tree" };
  if (name === "cose") return { ...base, nodeRepulsion: 8000, idealEdgeLength: 90 };
  return base;
}

// Heuristic node icons (inline white SVGs, viewBox 24x24). Inlined as data URIs
// so they ship embedded — no CDN / icon font, works offline.
const ICON: Record<string, string> = {
  // monitor — a VM
  vm: "<rect x='3' y='4' width='18' height='13' rx='1'/><path d='M8 21h8M12 17v4'/>",
  // plug/jack — a NIC
  nic: "<path d='M8 2v4M16 2v4'/><path d='M5 6h14v7a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5z'/><path d='M12 18v4'/>",
  // connected nodes — a network / portgroup
  net: "<circle cx='6' cy='12' r='2.4'/><circle cx='18' cy='6' r='2.4'/><circle cx='18' cy='18' r='2.4'/><path d='M8.2 10.9l7.6-3.6M8.2 13.1l7.6 3.6'/>",
  // chain link — a NetworkAttachmentDefinition (attachment)
  nad: "<path d='M9 12h6'/><path d='M10 8H8a4 4 0 0 0 0 8h2'/><path d='M14 8h2a4 4 0 0 1 0 8h-2'/>",
  // globe — a Calico Network
  cnet: "<circle cx='12' cy='12' r='9'/><path d='M3 12h18'/><path d='M12 3c3 3 3 15 0 18c-3-3-3-15 0-18z'/>",
  // cylinder — an IP pool
  pool: "<ellipse cx='12' cy='6' rx='7' ry='3'/><path d='M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6'/><path d='M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3'/>",
  // clipboard with a checkmark — a Migration Plan
  plan: "<rect x='5' y='4' width='14' height='17' rx='2'/><path d='M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1'/><path d='M9 13l2 2 4-4'/>",
  // bidirectional arrows — a live migration (move between nodes)
  lmig: "<path d='M17 4l3 3-3 3'/><path d='M20 7H9'/><path d='M7 20l-3-3 3-3'/><path d='M4 17h11'/>",
  // stacked boxes — a virt-launcher pod / node placement
  pod: "<rect x='3' y='4' width='18' height='7' rx='1'/><rect x='3' y='13' width='18' height='7' rx='1'/><path d='M7 7.5h.01M7 16.5h.01'/>",
};

function iconUri(paths: string): string {
  // Explicit width/height give the SVG an intrinsic 1:1 size so the renderer
  // centers it predictably (without them it can anchor to the top).
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' " +
    "stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>" +
    paths +
    "</svg>";
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

function iconStyle(type: string, color: string, size = 44): Record<string, unknown> {
  return {
    "background-color": color,
    "background-image": iconUri(ICON[type]),
    width: size,
    height: size,
  };
}

function graphStyle(): Array<Record<string, unknown>> {
  return [
    {
      selector: "node",
      style: {
        label: "data(label)",
        color: "#e6edf3",
        "font-size": 10,
        "text-valign": "bottom",
        "text-margin-y": 5,
        "text-wrap": "ellipsis",
        "text-max-width": 120,
        shape: "ellipse",
        "background-color": "#222d3d",
        // Icon centered on both axes, sized to leave a colored ring around it.
        "background-fit": "none",
        "background-clip": "none",
        "background-repeat": "no-repeat",
        "background-width": "56%",
        "background-height": "56%",
        "background-position-x": "50%",
        "background-position-y": "50%",
        "border-width": 2,
        "border-color": "#2c3a4f",
        width: 44,
        height: 44,
      },
    },
    { selector: "node.plan", style: iconStyle("plan", "#b07cff", 52) },
    { selector: "node.vm", style: iconStyle("vm", "#4aa3ff") },
    { selector: "node.ocpvm", style: iconStyle("vm", "#4aa3ff") },
    { selector: "node.lmig", style: iconStyle("lmig", "#ff9f43", 48) },
    { selector: "node.vmi", style: iconStyle("vm", "#2bb3c0") },
    { selector: "node.pod", style: iconStyle("pod", "#8b9bb0") },
    { selector: "node.lmold", style: iconStyle("pod", "#8b9bb0") },
    { selector: "node.lmnew", style: iconStyle("pod", "#2ed573") },
    { selector: "node.nic", style: iconStyle("nic", "#8b9bb0", 30) },
    { selector: "node.net", style: iconStyle("net", "#2ed573") },
    { selector: "node.nad", style: iconStyle("nad", "#4aa3ff") },
    { selector: "node.cnet", style: iconStyle("cnet", "#2ed573") },
    { selector: "node.pool", style: iconStyle("pool", "#ff9f43") },
    { selector: "node.warn", style: { "border-color": "#ffc04a", "border-width": 3 } },
    { selector: "node.error", style: { "border-color": "#ff6b6b", "border-width": 4 } },
    { selector: "node:selected", style: { "border-color": "#ffffff", "border-width": 4 } },
    {
      selector: "edge",
      style: {
        width: 2,
        "line-color": "#2c3a4f",
        "target-arrow-color": "#2c3a4f",
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
      },
    },
  ];
}

// ====================================================================
// Detail drawer
// ====================================================================
// Friendly type names for the detail pane's type chip.
const TYPE_LABEL: Record<string, string> = {
  vm: "VM",
  nic: "NIC",
  net: "Network / Portgroup",
  nad: "NetworkAttachmentDefinition",
  cnet: "Calico Network",
  pool: "IPPool",
  ocpvm: "KubeVirt VM",
  vmi: "VirtualMachineInstance",
  plan: "Migration Plan",
  lmig: "Live Migration",
  lmold: "Source (pre-migration)",
  lmnew: "Target (post-migration)",
};
function typeLabel(ntype: string | undefined): string {
  return (ntype && TYPE_LABEL[ntype]) || ntype || "";
}

// For a Calico Network, list the VLANs declared on the resource and the subnets
// named under each (plus the IPPools eligible for that VLAN).
function calicoVlanSection(raw: Record<string, unknown>): HTMLElement | null {
  const vlans = raw["vlans"] as Array<{ vid?: number; subnets?: string[]; eligiblePools?: string[] }> | undefined;
  if (!vlans || vlans.length === 0) return null;
  const rows = vlans.map((v) =>
    el(
      "div",
      { class: "vlan-row" },
      el("div", { class: "vlan-id" }, `VLAN ${v.vid ?? "?"}`),
      el("div", { class: "vlan-sub" }, "subnets: " + ((v.subnets ?? []).join(", ") || "—")),
      el("div", { class: "vlan-sub" }, "eligible IPPools: " + ((v.eligiblePools ?? []).join(", ") || "none")),
    ),
  );
  return el("div", {}, el("h3", {}, `vlans / subnets (${vlans.length})`), ...rows);
}

function showDetail(node: CyNode): void {
  const d: GraphNodeData = node.data();
  // Plans get a live progress pane sourced from the latest snapshot (so polling
  // can refresh it in place as the migration advances).
  if (d.ntype === "plan") {
    const pl = (lastSnapshot?.plans ?? []).find((p) => planKey(p) === node.id());
    if (pl) {
      renderPlanDetail(pl);
      return;
    }
  }

  openPlanKey = null;
  const root = byId("detail");
  const children: HTMLElement[] = [
    el("span", { class: "close", onclick: clearDetail }, "✕"),
    el("div", { class: "d-type" }, typeLabel(d.ntype)),
    el("h2", {}, d.label || d.id),
  ];

  const status = vlanStatus(d);
  if (status) children.push(status);

  if (d.ntype === "cnet") {
    const vlans = calicoVlanSection(d.raw ?? {});
    if (vlans) children.push(vlans);
  }

  children.push(el("h3", {}, "details"), kvTable(d.raw ?? {}));

  const errs: ErrorItem[] = sortErrors(d.errors ?? []);
  if (errs.length) {
    children.push(el("h3", {}, `errors (${errs.length})`));
    for (const e of errs) children.push(errItem(e));
  }

  root.replaceChildren(...children);
  root.classList.remove("hidden");
  byId("app-grid").classList.add("detail-open");
}

// ---- migration plan detail with a live progress section ----

function renderPlanDetail(plan: Plan): void {
  openPlanKey = planKey(plan);
  const root = byId("detail");
  root.replaceChildren(
    el("span", { class: "close", onclick: clearDetail }, "✕"),
    el("div", { class: "d-type" }, "Migration Plan"),
    el("h2", {}, plan.name),
    el("div", { class: "ns" }, plan.namespace || "—"),
    planProgress(plan.status),
    el("h3", {}, "details"),
    kvTable({ name: plan.name, namespace: plan.namespace, vms: plan.vms }),
  );
  root.classList.remove("hidden");
  byId("app-grid").classList.add("detail-open");
}

function phaseClass(phase: string): string {
  const p = phase.toLowerCase();
  if (p === "succeeded" || p === "completed") return "succeeded";
  if (p === "failed" || p === "error") return "failed";
  if (p === "canceled" || p === "cancelled") return "canceled";
  if (p === "executing" || p === "running") return "running";
  return "pending";
}

function bar(pct: number, cls: string): HTMLElement {
  const fill = el("div", { class: "bar-fill " + cls });
  fill.setAttribute("style", `width:${Math.max(0, Math.min(100, pct))}%`);
  return el("div", { class: "bar" }, fill);
}

function planProgress(status: PlanStatus | undefined): HTMLElement {
  const phase = migrationPhase(status);
  const cls = phaseClass(phase);
  const wrap = el("div", { class: "progress" });
  wrap.appendChild(
    el("div", { class: "progress-head" }, el("span", { class: "phase-badge " + cls }, phase), timing(status)),
  );

  const vms = status?.vms ?? [];
  if (vms.length === 0) {
    wrap.appendChild(
      el(
        "div",
        { class: "subtitle" },
        phase === "Not started" ? "Migration has not started." : "No per-VM status yet.",
      ),
    );
    return wrap;
  }

  // Overall: VMs completed / total + an averaged bar.
  const done = vms.filter((v) => vmProgress(v).pct >= 100).length;
  const overall = Math.round(vms.reduce((a, v) => a + vmProgress(v).pct, 0) / vms.length);
  wrap.appendChild(el("div", { class: "progress-overall" }, `${done}/${vms.length} VMs migrated`));
  wrap.appendChild(bar(overall, cls));

  for (const v of vms) wrap.appendChild(vmProgressRow(v));
  return wrap;
}

function timing(status: PlanStatus | undefined): HTMLElement | null {
  if (!status?.started) return null;
  const started = new Date(status.started);
  const end = status.completed ? new Date(status.completed) : null;
  const secs = Math.max(0, Math.round(((end ? end.getTime() : Date.now()) - started.getTime()) / 1000));
  const mins = Math.floor(secs / 60);
  const elapsed = mins ? `${mins}m ${secs % 60}s` : `${secs}s`;
  return el("span", { class: "progress-timing" }, (end ? "took " : "elapsed ") + elapsed);
}

function vmProgressRow(v: PlanVMStatus): HTMLElement {
  const prog = vmProgress(v);
  const phase = v.phase || (prog.pct >= 100 ? "Completed" : "Pending");
  const cls = phaseClass(phase);
  const running = (v.pipeline ?? []).find((s) => (s.phase ?? "").toLowerCase() === "running");
  const row = el(
    "div",
    { class: "pvm" },
    el(
      "div",
      { class: "pvm-head" },
      el("span", { class: "pvm-name" }, v.name || v.id || "vm"),
      el("span", { class: "phase-badge sm " + cls }, phase),
      el("span", { class: "pvm-pct" }, `${prog.pct}%`),
    ),
    bar(prog.pct, cls),
  );
  if (running?.name) row.appendChild(el("div", { class: "pvm-step" }, `▸ ${running.name}`));
  for (const e of v.error ?? []) row.appendChild(el("div", { class: "pvm-step err" }, e));
  return row;
}

// For a source VLAN (a portgroup with a numeric vlanId), report whether the
// destination has a Calico Network carrying the same VLAN, with a link that
// jumps to and selects that Network CR. Returns null for non-VLAN nodes.
function vlanStatus(d: GraphNodeData): HTMLElement | null {
  if (d.ntype !== "net" || !lastSnapshot) return null;
  const vid = vlanIdToNumber(d.raw?.["vlanId"] as string | undefined);
  if (vid === null) return null;

  const match = findCalicoNetworkByVlan(lastSnapshot, vid);
  const wrap = el(
    "div",
    { class: "d-status" },
    el("div", { class: "d-status-label" }, `Destination Calico Network · VLAN ${vid}`),
  );
  if (match) {
    const link = el("a", { class: "focus-link", href: "#" }, `✓ ${match.name} — focus on cluster`);
    link.onclick = (ev) => {
      ev.preventDefault();
      focusCalicoNetwork(match.name);
    };
    wrap.appendChild(el("div", { class: "ok" }, link));
  } else {
    wrap.appendChild(el("div", { class: "bad" }, `✗ no Calico Network with VLAN ${vid}`));
  }
  return wrap;
}

// Switch to the destination graph and focus/select the Calico Network CR node.
function focusCalicoNetwork(name: string): void {
  if (!lastSnapshot) return;
  activeKey = "dst";
  buildSidebar(lastSnapshot);
  renderActive(lastSnapshot);
  if (!cy) return;
  const node = cy.getElementById("cnet:" + name);
  if (node.empty()) return;
  cy.$(":selected").unselect();
  node.select();
  cy.center(node);
  showDetail(node);
}

function clearDetail(): void {
  openPlanKey = null;
  const root = byId("detail");
  root.classList.add("hidden");
  root.replaceChildren();
  byId("app-grid").classList.remove("detail-open");
  if (cy) cy.$(":selected").unselect();
}

function kvTable(raw: Record<string, unknown>): HTMLElement {
  const rows: HTMLElement[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (k === "concerns" || k === "errors" || k === "vlans") continue; // shown in dedicated sections
    rows.push(el("tr", {}, el("td", { class: "k" }, k), el("td", { class: "v" }, fmtVal(v))));
  }
  if (rows.length === 0) rows.push(el("tr", {}, el("td", { class: "v" }, "—")));
  return el("table", { class: "kv" }, el("tbody", {}, ...rows));
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return `${v.length} item(s)`;
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  }
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

// An error is either a Forklift concern object or a plain string.
function errItem(e: ErrorItem): HTMLElement {
  if (typeof e === "string") return el("div", { class: "err-item plain" }, e);
  return el(
    "div",
    { class: "err-item" },
    el(
      "div",
      {},
      el("span", { class: sevClass(e.category) }, e.category || "Information"),
      el("span", { class: "lbl" }, e.label || e.id || "concern"),
    ),
    e.assessment ? el("div", { class: "assess" }, e.assessment) : null,
  );
}

// ====================================================================
// Wiring
// ====================================================================
byId<HTMLButtonElement>("reload").onclick = (e) => fetchData("/api/inventory", e.currentTarget as HTMLButtonElement);
byId<HTMLButtonElement>("repoll").onclick = (e) => fetchData("/api/refresh", e.currentTarget as HTMLButtonElement);
byId<HTMLSelectElement>("layout").onchange = () => {
  if (lastSnapshot) renderActive(lastSnapshot);
};

// While a migration plan's progress pane is open, poll its (cheap) status and
// re-render the pane in place so progress advances as the CR changes. The graph
// itself is left untouched to preserve zoom/selection.
let planPollInFlight = false;
async function pollPlanProgress(): Promise<void> {
  if (!openPlanKey || planPollInFlight || !lastSnapshot) return;
  planPollInFlight = true;
  try {
    const resp = await fetch("/api/plans", { cache: "no-store" });
    const data = (await resp.json()) as { plans?: Plan[] };
    lastSnapshot.plans = data.plans ?? [];
    const pl = lastSnapshot.plans.find((p) => planKey(p) === openPlanKey);
    if (pl) renderPlanDetail(pl);
  } catch {
    /* transient; try again next tick */
  } finally {
    planPollInFlight = false;
  }
}
setInterval(() => void pollPlanProgress(), 5000);

void fetchData("/api/inventory");
