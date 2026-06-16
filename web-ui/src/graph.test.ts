import { test } from "node:test";
import assert from "node:assert/strict";

import {
  calicoNads,
  concernCounts,
  destElements,
  findCalicoNetworkByVlan,
  liveMigrationElements,
  migrationPhase,
  networkIndex,
  parseNadConfig,
  planElements,
  sortErrors,
  sourceElements,
  vlanIdToNumber,
  vmProgress,
} from "./graph.js";
import type { Concern, ErrorItem, GraphElement, GraphNodeData, Nad, Provider, Snapshot } from "./types.js";

const isNode = (e: GraphElement): e is { data: GraphNodeData; classes?: string } => !("source" in e.data);
const nodes = (els: GraphElement[]) => els.filter(isNode);
const edges = (els: GraphElement[]) => els.filter((e) => !isNode(e));
const nodeIds = (els: GraphElement[]) => new Set(nodes(els).map((e) => e.data.id));

test("concernCounts tallies by severity and defaults unknowns to Information", () => {
  const counts = concernCounts({
    concerns: [{ category: "Critical" }, { category: "Warning" }, { category: "Warning" }, { category: "Bogus" }, {}],
  });
  assert.deepEqual(counts, { Critical: 1, Warning: 2, Information: 2 });
});

test("sortErrors orders worst-first (strings, then Critical/Warning/Information) and is stable", () => {
  const errs: ErrorItem[] = [
    { category: "Information", label: "info" } as Concern,
    { category: "Warning", label: "w1" } as Concern,
    "hard error string",
    { category: "Critical", label: "crit" } as Concern,
    { category: "Warning", label: "w2" } as Concern,
  ];
  const sorted = sortErrors(errs);
  const labels = sorted.map((e) => (typeof e === "string" ? e : e.label));
  assert.deepEqual(labels, ["hard error string", "crit", "w1", "w2", "info"]);
  // input not mutated
  assert.equal((errs[0] as Concern).label, "info");
});

test("vlanIdToNumber parses single ids and rejects ranges/empty", () => {
  assert.equal(vlanIdToNumber("10"), 10);
  assert.equal(vlanIdToNumber("0-4094"), null);
  assert.equal(vlanIdToNumber(""), null);
  assert.equal(vlanIdToNumber(undefined), null);
});

test("findCalicoNetworkByVlan matches a destination network by VLAN id", () => {
  const snap: Snapshot = {
    calico: {
      networks: [
        { name: "vlan10", vlans: [{ vid: 10, subnets: ["10.0.10.0/24"] }] },
        { name: "vlan20", vlans: [{ vid: 20 }] },
      ],
    },
  };
  assert.equal(findCalicoNetworkByVlan(snap, 10)?.name, "vlan10");
  assert.equal(findCalicoNetworkByVlan(snap, 99), undefined);
  assert.equal(findCalicoNetworkByVlan({}, 10), undefined);
});

test("parseNadConfig parses calico CNI config and tolerates junk", () => {
  const nad: Nad = { object: { spec: { config: '{"type":"calico","network":"vlan10","vlan":10}' } } };
  assert.deepEqual(parseNadConfig(nad), { type: "calico", network: "vlan10", vlan: 10 });
  assert.equal(parseNadConfig({ object: { spec: { config: "not json" } } }), null);
  assert.equal(parseNadConfig({}), null);
});

test("networkIndex maps id -> network", () => {
  const p: Provider = { type: "vsphere", uid: "u", resources: { networks: [{ id: "n1", name: "A" }, { id: "n2" }] } };
  const idx = networkIndex(p);
  assert.equal(idx["n1"].name, "A");
  assert.ok(idx["n2"]);
});

test("sourceElements builds VM -> NIC -> Network and flags VMs with Critical concerns", () => {
  const provider: Provider = {
    type: "vsphere",
    uid: "u-1",
    resources: {
      networks: [
        { id: "dvpg-1", name: "VM Net", vlanId: "10" },
        { id: "dvpg-2", name: "Other" },
      ],
      vms: [
        {
          id: "vm-1",
          name: "web",
          nics: [
            { mac: "aa", network: { id: "dvpg-1" } },
            { mac: "bb", network: { id: "dvpg-2" } },
          ],
          concerns: [{ category: "Critical", label: "boom" }],
        },
        { id: "vm-2", name: "db", nics: [{ mac: "cc", network: { id: "missing-net" } }] },
      ],
    },
  };
  const els = sourceElements(provider);
  const ids = nodeIds(els);

  // 2 inventory networks + 2 VMs + 3 NICs + 1 synthetic "missing" network node = 8 nodes.
  assert.equal(nodes(els).length, 8);
  assert.ok(ids.has("vm:vm-1") && ids.has("vm:vm-2"));
  assert.ok(ids.has("nic:vm-1:0") && ids.has("nic:vm-1:1") && ids.has("nic:vm-2:0"));
  assert.ok(ids.has("net:dvpg-1") && ids.has("net:missing-net"));

  // vm-1 has a Critical concern -> error class; vm-2 has none.
  const vm1 = nodes(els).find((e) => e.data.id === "vm:vm-1")!;
  assert.match(vm1.classes ?? "", /\berror\b/);
  const vm2 = nodes(els).find((e) => e.data.id === "vm:vm-2")!;
  assert.doesNotMatch(vm2.classes ?? "", /\berror\b/);

  // the unresolved NIC network is flagged
  const missingNet = nodes(els).find((e) => e.data.id === "net:missing-net")!;
  assert.match(missingNet.classes ?? "", /\berror\b/);

  // edges: 3 vm->nic + 3 nic->net = 6
  assert.equal(edges(els).length, 6);
});

test("migrationPhase derives the dominant 'True' condition", () => {
  assert.equal(migrationPhase(undefined), "Not started");
  assert.equal(migrationPhase({ conditions: [] }), "Not started");
  assert.equal(migrationPhase({ conditions: [{ type: "Ready", status: "True" }] }), "Ready");
  assert.equal(
    migrationPhase({
      conditions: [
        { type: "Ready", status: "True" },
        { type: "Executing", status: "True" },
      ],
    }),
    "Executing",
  );
  assert.equal(
    migrationPhase({
      conditions: [
        { type: "Executing", status: "False" },
        { type: "Failed", status: "True" },
      ],
    }),
    "Failed",
  );
});

test("vmProgress sums pipeline units and infers from phase when none", () => {
  assert.deepEqual(
    vmProgress({
      pipeline: [
        { completed: 40, total: 100 },
        { completed: 10, total: 100 },
      ],
    }),
    { completed: 50, total: 200, pct: 25 },
  );
  assert.equal(vmProgress({ phase: "Completed" }).pct, 100);
  assert.equal(vmProgress({ phase: "Pending" }).pct, 0);
});

test("planElements builds Plan -> VM -> NIC -> Network -> NAD -> Calico Network -> IPPool, filtered to plan VMs", () => {
  const snap: Snapshot = {
    providers: [
      {
        type: "vsphere",
        uid: "u-1",
        resources: {
          networks: [{ id: "pg-10", name: "vlan10", vlanId: "10" }],
          vms: [
            {
              id: "vm-1",
              name: "in-plan",
              nics: [{ mac: "aa", network: { id: "pg-10" } }],
              concerns: [{ category: "Critical", label: "x" }],
            },
            { id: "vm-2", name: "not-in-plan", nics: [{ mac: "bb", network: { id: "pg-10" } }] },
          ],
        },
      },
      {
        type: "openshift",
        uid: "ocp",
        resources: {
          networkattachmentdefinitions: [
            { namespace: "vm", name: "nad10", object: { spec: { config: '{"type":"calico","network":"vlan10"}' } } },
          ],
        },
      },
    ],
    calico: {
      networks: [{ name: "vlan10", vlans: [{ vid: 10, subnets: ["10.0.0.0/16"], eligiblePools: ["pool-a"] }] }],
      ippools: [{ name: "pool-a", cidr: "10.0.1.0/24" }],
    },
    plans: [{ name: "migrate", namespace: "openshift-mtv", vms: [{ id: "vm-1" }] }],
  };

  const els = planElements(snap, snap.plans![0]);
  const ids = new Set(els.filter((e) => !("source" in e.data)).map((e) => e.data.id));

  // only the in-plan VM appears, plus the full chain
  assert.ok(ids.has("plan:openshift-mtv/migrate"));
  assert.ok(ids.has("vm:vm-1") && !ids.has("vm:vm-2"));
  assert.ok(ids.has("nic:vm-1:0") && ids.has("net:pg-10"));
  assert.ok(ids.has("nad:vm/nad10") && ids.has("cnet:vlan10") && ids.has("pool:pool-a"));

  // chain edges exist end-to-end
  const edgeSet = new Set(
    els
      .filter((e) => "source" in e.data)
      .map((e) => `${(e.data as { source: string }).source}->${(e.data as { target: string }).target}`),
  );
  assert.ok(edgeSet.has("plan:openshift-mtv/migrate->vm:vm-1"));
  assert.ok(edgeSet.has("vm:vm-1->nic:vm-1:0"));
  assert.ok(edgeSet.has("nic:vm-1:0->net:pg-10"));
  assert.ok(edgeSet.has("net:pg-10->nad:vm/nad10"));
  assert.ok(edgeSet.has("nad:vm/nad10->cnet:vlan10"));
  assert.ok(edgeSet.has("cnet:vlan10->pool:pool-a"));
});

test("liveMigrationElements ties a VMIM to its VMI and old/new placements", () => {
  const els = liveMigrationElements({
    namespace: "migration-target",
    name: "lm-vm0",
    vmiName: "dc0-h0-vm0",
    phase: "Succeeded",
    sourceNode: "kind-worker2",
    sourcePod: "virt-launcher-src",
    targetNode: "kind-worker",
    targetPod: "virt-launcher-tgt",
  });
  const ids = nodeIds(els);
  assert.ok(ids.has("lmig:migration-target/lm-vm0"));
  assert.ok(ids.has("vmi:migration-target/dc0-h0-vm0"));
  assert.ok(ids.has("lmold:migration-target/lm-vm0") && ids.has("lmnew:migration-target/lm-vm0"));

  const edgeSet = new Set(
    edges(els).map((e) => `${(e.data as { source: string }).source}->${(e.data as { target: string }).target}`),
  );
  assert.ok(edgeSet.has("lmig:migration-target/lm-vm0->vmi:migration-target/dc0-h0-vm0"));
  assert.ok(edgeSet.has("vmi:migration-target/dc0-h0-vm0->lmold:migration-target/lm-vm0"));
  assert.ok(edgeSet.has("vmi:migration-target/dc0-h0-vm0->lmnew:migration-target/lm-vm0"));

  // a failed migration flags the migration node
  const failed = liveMigrationElements({ namespace: "n", name: "f", vmiName: "v", phase: "Failed", failed: true });
  const mig = nodes(failed).find((e) => e.data.id === "lmig:n/f")!;
  assert.match(mig.classes ?? "", /\berror\b/);
});

test("calicoNads extracts calico-typed NADs from openshift providers", () => {
  const snap: Snapshot = {
    providers: [
      {
        type: "openshift",
        uid: "ocp",
        resources: {
          networkattachmentdefinitions: [
            {
              namespace: "vm",
              name: "vlan10",
              object: { spec: { config: '{"type":"calico","network":"vlan10","vlan":10}' } },
            },
            { namespace: "vm", name: "bridge", object: { spec: { config: '{"type":"bridge"}' } } },
          ],
        },
      },
    ],
  };
  const nads = calicoNads(snap);
  assert.equal(nads.length, 1);
  assert.equal(nads[0].network, "vlan10");
});

test("destElements links NAD -> Calico Network -> eligible IPPool and flags no-pool / missing", () => {
  const snap: Snapshot = {
    providers: [
      {
        type: "openshift",
        uid: "ocp",
        resources: {
          networkattachmentdefinitions: [
            { namespace: "vm", name: "n10", object: { spec: { config: '{"type":"calico","network":"vlan10"}' } } },
            { namespace: "vm", name: "n99", object: { spec: { config: '{"type":"calico","network":"vlan99"}' } } },
            { namespace: "vm", name: "norphan", object: { spec: { config: '{"type":"calico","network":"ghost"}' } } },
          ],
          vms: [
            {
              name: "dc0-h0-vm0",
              namespace: "vm",
              object: {
                spec: { template: { spec: { networks: [{ name: "net-0", multus: { networkName: "vm/n10" } }] } } },
                status: { printableStatus: "Running" },
              },
            },
            // a VM with no multus network — should NOT appear in the graph
            {
              name: "podonly",
              namespace: "vm",
              object: { spec: { template: { spec: { networks: [{ name: "default", pod: {} }] } } } },
            },
          ],
        },
      },
    ],
    vmis: [{ namespace: "vm", name: "dc0-h0-vm0", phase: "Running", node: "kind-worker2" }],
    launcherPods: [
      {
        namespace: "vm",
        name: "virt-launcher-dc0-h0-vm0-m4xwn",
        vmName: "dc0-h0-vm0",
        node: "kind-worker2",
        phase: "Running",
      },
    ],
    calico: {
      networks: [
        { name: "vlan10", vlans: [{ vid: 10, subnets: ["10.0.0.0/16"], eligiblePools: ["pool-a"] }] },
        {
          name: "vlan99",
          vlans: [{ vid: 99, subnets: ["10.99.0.0/16"], eligiblePools: [] }],
          errors: ["VLAN 99 has no eligible IPPool"],
        },
      ],
      ippools: [{ name: "pool-a", cidr: "10.0.1.0/24" }],
    },
  };
  const els = destElements(snap);
  const ids = nodeIds(els);

  assert.ok(ids.has("nad:vm/n10") && ids.has("cnet:vlan10") && ids.has("pool:pool-a"));
  // vlan10 -> pool-a edge exists
  assert.ok(
    edges(els).some((e) => "source" in e.data && e.data.source === "cnet:vlan10" && e.data.target === "pool:pool-a"),
  );

  // vlan99 network is flagged (no eligible pool)
  const v99 = nodes(els).find((e) => e.data.id === "cnet:vlan99")!;
  assert.match(v99.classes ?? "", /\berror\b/);

  // the orphan NAD references a missing network -> NAD flagged + synthetic missing node
  const orphan = nodes(els).find((e) => e.data.id === "nad:vm/norphan")!;
  assert.match(orphan.classes ?? "", /\berror\b/);
  assert.ok(ids.has("cnet:missing:ghost"));

  // destination VM expands to VM -> VMI -> launcher pod, and the pod (deepest)
  // owns the NAD attachment; pod-only VM is excluded.
  assert.ok(ids.has("ocpvm:vm/dc0-h0-vm0") && !ids.has("ocpvm:vm/podonly"));
  assert.ok(ids.has("vmi:vm/dc0-h0-vm0") && ids.has("pod:vm/virt-launcher-dc0-h0-vm0-m4xwn"));
  const edgeSet = new Set(
    edges(els).map((e) => `${(e.data as { source: string }).source}->${(e.data as { target: string }).target}`),
  );
  assert.ok(edgeSet.has("ocpvm:vm/dc0-h0-vm0->vmi:vm/dc0-h0-vm0"));
  assert.ok(edgeSet.has("vmi:vm/dc0-h0-vm0->pod:vm/virt-launcher-dc0-h0-vm0-m4xwn"));
  assert.ok(edgeSet.has("pod:vm/virt-launcher-dc0-h0-vm0-m4xwn->nad:vm/n10"));
});
