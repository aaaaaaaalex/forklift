// Pure transforms: snapshot -> graph elements, plus the helpers they share.
// No DOM access here, so this module is unit-testable under Node.
import type {
  CalicoIPPool,
  CalicoNetwork,
  Concern,
  ErrorItem,
  GraphElement,
  LauncherPod,
  LiveMigration,
  Nad,
  Plan,
  PlanStatus,
  PlanVMStatus,
  Provider,
  Snapshot,
  VM,
  VMIRef,
  VNetwork,
} from "./types.js";

export const SEVERITIES = ["Critical", "Warning", "Information"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const DEST_TYPES = new Set<string>(["openshift"]);

export type SeverityCounts = Record<Severity, number>;

/** Tally a resource's concerns by severity (unknown categories -> Information). */
export function concernCounts(item: { concerns?: Concern[] }): SeverityCounts {
  const out: SeverityCounts = { Critical: 0, Warning: 0, Information: 0 };
  for (const c of item.concerns ?? []) {
    const cat: Severity = (SEVERITIES as readonly string[]).includes(c.category ?? "")
      ? (c.category as Severity)
      : "Information";
    out[cat]++;
  }
  return out;
}

export function sevClass(cat: string | undefined): string {
  return "sev " + ((SEVERITIES as readonly string[]).includes(cat ?? "") ? cat!.toLowerCase() : "information");
}

/** Severity rank of one error (lower = more severe). Plain error strings and
 *  unknown categories sort first/last respectively. */
export function errorRank(e: ErrorItem): number {
  if (typeof e === "string") return -1; // hard error strings before any concern
  const i = (SEVERITIES as readonly string[]).indexOf(e.category ?? "");
  return i === -1 ? SEVERITIES.length : i; // unknown category -> last
}

/** Sort errors worst-first (Critical -> Warning -> Information), stable within
 *  a severity so original order is preserved. Does not mutate the input. */
export function sortErrors(errors: ErrorItem[]): ErrorItem[] {
  return [...errors].sort((a, b) => errorRank(a) - errorRank(b));
}

/** Migration View graph for one Plan: Plan -> VM -> NIC -> source Network(VLAN)
 *  -> [VLAN-number bridge] -> destination NAD -> Calico Network -> IPPool.
 *  Only nodes reachable from the Plan's VMs are included. */
export function planElements(snap: Snapshot, plan: Plan): GraphElement[] {
  const els: GraphElement[] = [];
  const seen = new Set<string>();
  const add = (e: GraphElement): void => {
    if (seen.has(e.data.id)) return;
    seen.add(e.data.id);
    els.push(e);
  };

  // Destination lookups.
  const poolByName: Record<string, CalicoIPPool> = {};
  for (const p of snap.calico?.ippools ?? []) poolByName[p.name] = p;
  const nadsByNet: Record<string, CalicoNadRef[]> = {};
  for (const n of calicoNads(snap)) if (n.network) (nadsByNet[n.network] ??= []).push(n);
  const usedNets = new Set<string>();
  const usedPools = new Set<string>();

  const sources = (snap.providers ?? []).filter((p) => !DEST_TYPES.has(p.type));

  const planId = `plan:${plan.namespace}/${plan.name}`;
  add({
    data: {
      id: planId,
      label: plan.name,
      ntype: "plan",
      raw: { name: plan.name, namespace: plan.namespace, vms: plan.vms, status: plan.status },
      errors: [],
    },
    classes: "plan",
  });

  for (const pvm of plan.vms ?? []) {
    let vm: VM | undefined;
    let provider: Provider | undefined;
    for (const prov of sources) {
      const found = (prov.resources?.vms ?? []).find(
        (v) => (pvm.id && v.id === pvm.id) || (pvm.name && v.name === pvm.name),
      );
      if (found) {
        vm = found;
        provider = prov;
        break;
      }
    }

    const vmId = "vm:" + (vm?.id || vm?.uid || pvm.id || pvm.name);
    const counts = vm ? concernCounts(vm) : { Critical: 0, Warning: 0, Information: 0 };
    const vmCls = "vm" + (counts.Critical ? " error" : counts.Warning ? " warn" : "");
    add({
      data: {
        id: vmId,
        label: vm?.name || pvm.name || pvm.id || "vm",
        ntype: "vm",
        raw: vm ?? { id: pvm.id, name: pvm.name },
        errors: vm?.concerns ?? [],
      },
      classes: vmCls,
    });
    add({ data: { id: `e:${planId}->${vmId}`, source: planId, target: vmId } });
    if (!vm || !provider) continue; // referenced VM not in the inventory

    const nets = networkIndex(provider);
    (vm.nics ?? []).forEach((nic, i) => {
      const nicId = `nic:${vm!.id || vm!.uid}:${i}`;
      add({ data: { id: nicId, label: nic.mac || `nic ${i}`, ntype: "nic", raw: nic, errors: [] }, classes: "nic" });
      add({ data: { id: `e:${vmId}->${nicId}`, source: vmId, target: nicId } });

      const ref = nic.network?.id;
      if (!ref) return;
      const net = nets[ref];
      const netId = "net:" + ref;
      add({
        data: {
          id: netId,
          label: net ? netLabel(net) : ref + " (unknown)",
          ntype: "net",
          raw: net ?? { id: ref },
          errors: net ? [] : ["Network not present in inventory"],
        },
        classes: "net" + (net ? "" : " error"),
      });
      add({ data: { id: `e:${nicId}->${netId}`, source: nicId, target: netId } });

      // Bridge source VLAN -> destination Calico Network (same VLAN id).
      const vid = vlanIdToNumber(net?.vlanId);
      if (vid === null) return;
      const cnet = findCalicoNetworkByVlan(snap, vid);
      if (!cnet) return;
      const cnetId = pushCalicoNetwork(els, cnet, poolByName, usedNets, usedPools);
      const matchingNads = nadsByNet[cnet.name] ?? [];
      if (matchingNads.length) {
        for (const nd of matchingNads) {
          const nadId = `nad:${nd.namespace}/${nd.name}`;
          add({
            data: {
              id: nadId,
              label: nd.name,
              ntype: "nad",
              raw: {
                namespace: nd.namespace,
                name: nd.name,
                network: nd.network,
                vlan: nd.vlan,
                ...(nd.object ? { object: nd.object } : {}),
              },
              errors: [],
            },
            classes: "nad",
          });
          add({ data: { id: `e:${netId}->${nadId}`, source: netId, target: nadId } });
          add({ data: { id: `e:${nadId}->${cnetId}`, source: nadId, target: cnetId } });
        }
      } else {
        add({ data: { id: `e:${netId}->${cnetId}`, source: netId, target: cnetId } });
      }
    });
  }
  return els;
}

/** Live Migration view: VMIM -> the VMI being migrated -> the old (source) and
 *  new (target) VM placements (virt-launcher pod @ node), pre- and post-migration. */
export function liveMigrationElements(lm: LiveMigration): GraphElement[] {
  const els: GraphElement[] = [];
  const base = `${lm.namespace}/${lm.name}`;

  const migId = `lmig:${base}`;
  els.push({
    data: {
      id: migId,
      label: lm.name,
      ntype: "lmig",
      raw: {
        namespace: lm.namespace,
        name: lm.name,
        vmi: lm.vmiName,
        phase: lm.phase,
        completed: lm.completed,
        failed: lm.failed,
        started: lm.started,
        ended: lm.ended,
      },
      errors: lm.failed ? [`Live migration failed (phase ${lm.phase ?? "?"})`] : [],
    },
    classes: "lmig" + (lm.failed ? " error" : ""),
  });

  const vmiId = `vmi:${lm.namespace}/${lm.vmiName}`;
  els.push({
    data: {
      id: vmiId,
      label: lm.vmiName,
      ntype: "vmi",
      raw: { namespace: lm.namespace, name: lm.vmiName },
      errors: [],
    },
    classes: "vmi",
  });
  els.push({ data: { id: `e:${migId}->${vmiId}`, source: migId, target: vmiId } });

  if (lm.sourceNode || lm.sourcePod) {
    const oldId = `lmold:${base}`;
    els.push({
      data: {
        id: oldId,
        label: lm.sourceNode || lm.sourcePod || "source",
        ntype: "lmold",
        raw: { role: "source (before)", node: lm.sourceNode, pod: lm.sourcePod },
        errors: [],
      },
      classes: "lmold",
    });
    els.push({ data: { id: `e:${vmiId}->${oldId}`, source: vmiId, target: oldId } });
  }
  if (lm.targetNode || lm.targetPod) {
    const newId = `lmnew:${base}`;
    els.push({
      data: {
        id: newId,
        label: lm.targetNode || lm.targetPod || "target",
        ntype: "lmnew",
        raw: { role: "target (after)", node: lm.targetNode, pod: lm.targetPod },
        errors: [],
      },
      classes: "lmnew",
    });
    els.push({ data: { id: `e:${vmiId}->${newId}`, source: vmiId, target: newId } });
  }
  return els;
}

/** Parse a vSphere portgroup vlanId into a single 802.1Q VLAN number, or null
 *  when it is empty or a trunk range (e.g. "0-4094"). */
export function vlanIdToNumber(vlanId: string | undefined): number | null {
  return vlanId && /^\d+$/.test(vlanId) ? Number(vlanId) : null;
}

/** Find the destination Calico Network that carries the given VLAN id, if any. */
export function findCalicoNetworkByVlan(snap: Snapshot, vid: number): CalicoNetwork | undefined {
  return (snap.calico?.networks ?? []).find((n) => (n.vlans ?? []).some((v) => v.vid === vid));
}

// ---- migration progress (derived from Plan.status / its embedded Migration) ----

// Overall phase, most-significant first among the conditions set to "True".
const PHASE_PRIORITY = ["Failed", "Canceled", "Succeeded", "Executing", "Running", "Ready", "Pending"];

export function migrationPhase(status: PlanStatus | undefined): string {
  const conds = status?.conditions ?? [];
  if (conds.length === 0) return "Not started";
  const active = new Set(conds.filter((c) => c.status === "True").map((c) => c.type ?? ""));
  for (const p of PHASE_PRIORITY) if (active.has(p)) return p;
  return conds.find((c) => c.status === "True")?.type ?? "Unknown";
}

/** Per-VM progress: sum the pipeline steps' completed/total units. When a VM
 *  has no progress units yet, infer 0/100% from its phase. */
export function vmProgress(vm: PlanVMStatus): { completed: number; total: number; pct: number } {
  let completed = 0;
  let total = 0;
  for (const s of vm.pipeline ?? []) {
    completed += s.completed ?? 0;
    total += s.total ?? 0;
  }
  if (total === 0) {
    const done =
      (vm.phase ?? "").toLowerCase() === "completed" ||
      (vm.phase ?? "").toLowerCase() === "succeeded" ||
      !!vm.completed;
    return { completed: done ? 1 : 0, total: 1, pct: done ? 100 : 0 };
  }
  return { completed, total, pct: Math.round((completed / total) * 100) };
}

export interface NadConfig {
  type?: string;
  network?: string;
  vlan?: number;
  [key: string]: unknown;
}

/** Parse a NAD's spec.config CNI JSON. Returns null when absent/invalid. */
export function parseNadConfig(nad: Nad): NadConfig | null {
  const cfg = nad.object?.spec?.config;
  if (!cfg) return null;
  try {
    return JSON.parse(cfg) as NadConfig;
  } catch {
    return null;
  }
}

export interface CalicoNadRef {
  namespace?: string;
  name?: string;
  network?: string;
  vlan?: number;
  object?: Nad["object"];
}

/** Every Calico-typed NAD across the OpenShift providers. */
export function calicoNads(snap: Snapshot): CalicoNadRef[] {
  const out: CalicoNadRef[] = [];
  for (const p of snap.providers ?? []) {
    if (p.type !== "openshift") continue;
    for (const nad of p.resources?.networkattachmentdefinitions ?? []) {
      const cfg = parseNadConfig(nad);
      if (cfg && cfg.type === "calico") {
        out.push({
          namespace: nad.namespace,
          name: nad.name,
          network: cfg.network,
          vlan: cfg.vlan,
          object: nad.object,
        });
      }
    }
  }
  return out;
}

/** Map a provider's network id -> network, for resolving NIC references. */
export function networkIndex(provider: Provider): Record<string, VNetwork> {
  const idx: Record<string, VNetwork> = {};
  for (const n of provider.resources?.networks ?? []) if (n.id) idx[n.id] = n;
  return idx;
}

export function netLabel(n: VNetwork): string {
  let l = n.name || n.id || "network";
  if (n.vlanId) l += ` · vlan ${n.vlanId}`;
  return l;
}

/** Source env graph: VM -> NIC -> Network/Portgroup, with VM error flags. */
export function sourceElements(provider: Provider): GraphElement[] {
  const els: GraphElement[] = [];
  const seenNet = new Set<string>();

  for (const n of provider.resources?.networks ?? []) {
    if (!n.id) continue;
    els.push({ data: { id: "net:" + n.id, label: netLabel(n), ntype: "net", raw: n, errors: [] }, classes: "net" });
    seenNet.add(n.id);
  }

  for (const vm of provider.resources?.vms ?? []) {
    const counts = concernCounts(vm);
    const cls = "vm" + (counts.Critical ? " error" : counts.Warning ? " warn" : "");
    const vmId = "vm:" + (vm.id || vm.uid || vm.name);
    els.push({
      data: { id: vmId, label: vm.name || "(vm)", ntype: "vm", raw: vm, errors: vm.concerns ?? [] },
      classes: cls,
    });

    (vm.nics ?? []).forEach((nic, i) => {
      const nicId = `nic:${vm.id || vm.uid}:${i}`;
      els.push({
        data: { id: nicId, label: nic.mac || `nic ${i}`, ntype: "nic", raw: nic, errors: [] },
        classes: "nic",
      });
      els.push({ data: { id: `e:${vmId}->${nicId}`, source: vmId, target: nicId } });

      const netRef = nic.network?.id;
      if (netRef) {
        const netId = "net:" + netRef;
        if (!seenNet.has(netRef)) {
          els.push({
            data: {
              id: netId,
              label: netRef + " (unknown)",
              ntype: "net",
              raw: { id: netRef },
              errors: ["Network not present in inventory"],
            },
            classes: "net error",
          });
          seenNet.add(netRef);
        }
        els.push({ data: { id: `e:${nicId}->${netId}`, source: nicId, target: netId } });
      }
    });
  }
  return els;
}

/** Multus NAD references (and running status) of a destination KubeVirt VM. */
export function ocpVmInfo(vm: VM): { nadKeys: string[]; status?: string } {
  const obj = vm.object as
    | {
        spec?: { template?: { spec?: { networks?: Array<{ multus?: { networkName?: string } }> } } };
        status?: { printableStatus?: string };
      }
    | undefined;
  const keys: string[] = [];
  for (const n of obj?.spec?.template?.spec?.networks ?? []) {
    const nn = n?.multus?.networkName;
    if (typeof nn === "string" && nn) keys.push(nn.includes("/") ? nn : `${vm.namespace}/${nn}`);
  }
  return { nadKeys: keys, status: obj?.status?.printableStatus };
}

/** Destination env graph: KubeVirt VM -> NAD -> Calico Network -> IPPool. */
export function destElements(snap: Snapshot): GraphElement[] {
  const els: GraphElement[] = [];
  const seen = new Set<string>();
  const add = (e: GraphElement): void => {
    if (seen.has(e.data.id)) return;
    seen.add(e.data.id);
    els.push(e);
  };

  const calico = snap.calico ?? { networks: [], ippools: [] };
  const netByName: Record<string, CalicoNetwork> = {};
  for (const n of calico.networks ?? []) netByName[n.name] = n;
  const poolByName: Record<string, CalicoIPPool> = {};
  for (const p of calico.ippools ?? []) poolByName[p.name] = p;
  const usedNets = new Set<string>();
  const usedPools = new Set<string>();

  // Index every OpenShift NAD by ns/name so VM multus refs resolve.
  const nadByKey = new Map<string, CalicoNadRef & { calico: boolean }>();
  for (const p of snap.providers ?? []) {
    if (p.type !== "openshift") continue;
    for (const nad of p.resources?.networkattachmentdefinitions ?? []) {
      const cfg = parseNadConfig(nad);
      nadByKey.set(`${nad.namespace}/${nad.name}`, {
        namespace: nad.namespace,
        name: nad.name,
        object: nad.object,
        network: cfg?.network,
        vlan: cfg?.vlan,
        calico: cfg?.type === "calico",
      });
    }
  }

  // Add a NAD node and (for Calico NADs) its Network -> IPPool chain. Idempotent.
  const addNad = (key: string): string => {
    const nadId = "nad:" + key;
    if (seen.has(nadId)) return nadId;
    const nad = nadByKey.get(key);
    if (!nad) {
      add({
        data: {
          id: nadId,
          label: (key.split("/")[1] || key) + " (not found)",
          ntype: "nad",
          raw: { ref: key },
          errors: [`NAD "${key}" not found in inventory`],
        },
        classes: "nad error",
      });
      return nadId;
    }
    const net = nad.network ? netByName[nad.network] : undefined;
    const missing = nad.calico && Boolean(nad.network) && !net;
    add({
      data: {
        id: nadId,
        label: nad.name,
        ntype: "nad",
        raw: {
          namespace: nad.namespace,
          name: nad.name,
          network: nad.network,
          vlan: nad.vlan,
          ...(nad.object ? { object: nad.object } : {}),
        },
        errors: missing ? [`Calico Network "${nad.network}" referenced by this NAD was not found on the cluster`] : [],
      },
      classes: "nad" + (missing ? " error" : ""),
    });
    if (missing) {
      const mId = `cnet:missing:${nad.network}`;
      add({
        data: {
          id: mId,
          label: nad.network + " (missing)",
          ntype: "cnet",
          raw: { name: nad.network },
          errors: ["Network not found on cluster"],
        },
        classes: "cnet error",
      });
      add({ data: { id: `e:${nadId}->${mId}`, source: nadId, target: mId } });
    } else if (net) {
      const cnetId = pushCalicoNetwork(els, net, poolByName, usedNets, usedPools);
      add({ data: { id: `e:${nadId}->${cnetId}`, source: nadId, target: cnetId } });
    }
    return nadId;
  };

  // VMI + launcher-pod lookups (by ns/name and ns/vmName).
  const vmiByKey: Record<string, VMIRef> = {};
  for (const v of snap.vmis ?? []) vmiByKey[`${v.namespace}/${v.name}`] = v;
  const podByVm: Record<string, LauncherPod> = {};
  for (const pod of snap.launcherPods ?? []) if (pod.vmName) podByVm[`${pod.namespace}/${pod.vmName}`] = pod;

  // Destination VMs (KubeVirt): VM -> VMI -> launcher pod, the deepest of which
  // owns the NAD attachment(s) -> Calico Network -> IPPool.
  for (const p of snap.providers ?? []) {
    if (p.type !== "openshift") continue;
    for (const vm of p.resources?.vms ?? []) {
      const info = ocpVmInfo(vm);
      if (info.nadKeys.length === 0) continue; // only VMs attached to a NAD
      const key = `${vm.namespace}/${vm.name}`;
      const vmId = `ocpvm:${key}`;
      add({
        data: {
          id: vmId,
          label: vm.name || "(vm)",
          ntype: "ocpvm",
          raw: { namespace: vm.namespace, name: vm.name, status: info.status, networks: info.nadKeys.join(", ") },
          errors: [],
        },
        classes: "ocpvm",
      });

      let ownerId = vmId; // node that the NAD attaches to (deepest available)
      const vmi = vmiByKey[key];
      if (vmi) {
        const vmiId = `vmi:${key}`;
        add({
          data: {
            id: vmiId,
            label: vmi.name,
            ntype: "vmi",
            raw: { namespace: vmi.namespace, name: vmi.name, phase: vmi.phase, node: vmi.node },
            errors: [],
          },
          classes: "vmi",
        });
        add({ data: { id: `e:${vmId}->${vmiId}`, source: vmId, target: vmiId } });
        ownerId = vmiId;

        const pod = podByVm[key];
        if (pod) {
          const podId = `pod:${pod.namespace}/${pod.name}`;
          add({
            data: {
              id: podId,
              label: pod.name,
              ntype: "pod",
              raw: { namespace: pod.namespace, name: pod.name, node: pod.node, phase: pod.phase },
              errors: [],
            },
            classes: "pod",
          });
          add({ data: { id: `e:${vmiId}->${podId}`, source: vmiId, target: podId } });
          ownerId = podId;
        }
      }

      for (const nadKey of info.nadKeys) {
        const nadId = addNad(nadKey);
        add({ data: { id: `e:${ownerId}->${nadId}`, source: ownerId, target: nadId } });
      }
    }
  }

  // All Calico NADs (so unused ones still appear), then orphan Calico networks.
  for (const [key, nad] of nadByKey) if (nad.calico) addNad(key);
  for (const net of calico.networks ?? []) {
    if (!usedNets.has("cnet:" + net.name)) pushCalicoNetwork(els, net, poolByName, usedNets, usedPools);
  }
  return els;
}

export function pushCalicoNetwork(
  els: GraphElement[],
  net: CalicoNetwork,
  poolByName: Record<string, CalicoIPPool>,
  usedNets: Set<string>,
  usedPools: Set<string>,
): string {
  const netId = "cnet:" + net.name;
  if (usedNets.has(netId)) return netId;

  const hasErr = (net.errors ?? []).length > 0;
  els.push({
    data: { id: netId, label: net.name, ntype: "cnet", raw: net, errors: net.errors ?? [] },
    classes: "cnet" + (hasErr ? " error" : ""),
  });
  usedNets.add(netId);

  const pools = new Set<string>();
  for (const v of net.vlans ?? []) for (const pn of v.eligiblePools ?? []) pools.add(pn);
  for (const pn of pools) {
    const poolId = "pool:" + pn;
    if (!usedPools.has(poolId)) {
      const pool = poolByName[pn] ?? { name: pn };
      els.push({
        data: { id: poolId, label: pn + (pool.cidr ? " · " + pool.cidr : ""), ntype: "pool", raw: pool, errors: [] },
        classes: "pool",
      });
      usedPools.add(poolId);
    }
    els.push({ data: { id: `e:${netId}->${poolId}`, source: netId, target: poolId } });
  }
  return netId;
}
