# Forklift

Forklift migrates virtual machines from external hypervisors (vSphere, oVirt, OpenStack, OVA, Hyper-V, EC2) into KubeVirt running on Kubernetes or OpenShift.

## Repository layout

- `pkg/apis/forklift/v1beta1/` — CRD types: `Provider`, `NetworkMap`, `StorageMap`, `Plan`, `Migration`, `Hook`.
- `pkg/controller/plan/` — Plan reconciler, validation, and migration orchestration.
  - `validation.go` — top-level Plan validator; sets `Status.Conditions`.
  - `adapter/<provider>/` — per-source-provider `Validator` and `Builder`. The Validator runs per-VM checks during Plan validation; the Builder constructs the destination KubeVirt VM CR.
  - `adapter/base/` — shared types, the `Validator` interface, common helpers.
- `pkg/controller/provider/` — per-provider inventory (read-only model of the source cluster).
- `pkg/lib/client/` — thin clients for destination-side resources (e.g. `pkg/lib/client/calico/` for Calico Network / IPPool CRs).
- `operator/` — the OLM-packaged operator that deploys Forklift onto a cluster.

## Deployment

Forklift runs as an operator inside the destination cluster (the cluster that hosts KubeVirt and receives the migrated VMs).

```bash
kubectl create namespace konveyor-forklift
make deploy-operator-index PLATFORM=linux/amd64 REGISTRY_TAG=latest
```

That installs:
- A `ForkliftController` CR that the operator reconciles into the actual control-plane workloads.
- The Forklift controller manager (Plan / Migration / Provider reconcilers).
- Provider inventory pods (one per registered source `Provider`) that maintain an in-memory model of the source environment.
- An admission webhook for resource validation.

The single deployment serves all migrations targeting that cluster; source clusters need no installation.

## How a user drives a migration

The user creates a chain of CRs in the controller's namespace. Each CR is reconciled into a `Status.Conditions` list — Critical conditions block, Warn conditions surface but don't.

1. **`Secret`** — source provider credentials (vCenter URL/user/password/thumbprint, etc.).
2. **`Provider` (source)** — e.g. `type: vsphere`, references the Secret. The inventory pod is started for this provider; the user waits for `Ready`.
3. **`Provider` (destination)** — `type: openshift`, usually with empty `url`/`secret` to mean "this cluster".
4. **`NetworkMap`** — pairs of `{source network ID → destination network}`. Each destination is one of `pod` (use the default pod network), `multus` (attach a specific NAD by `namespace/name`), or `ignored` (drop the NIC).
5. **`StorageMap`** — pairs of `{source datastore → destination StorageClass}`.
6. **`Plan`** — references the two Providers and the two Maps, lists the VMs to migrate, sets `targetNamespace`, `type: cold|warm`, and per-feature flags such as `preserveStaticIPs`.
7. **`Migration`** — created last; references the Plan and triggers actual cutover.

The Plan reconciler runs `validate()` (`pkg/controller/plan/validation.go`) which dispatches per-VM checks through each provider's `Validator` (`pkg/controller/plan/adapter/<provider>/validator.go`). Conditions like `MacConflicts`, `SharedDisks`, `VMMissingGuestIPs`, etc. surface here. The user resolves them by fixing destination cluster state (NADs, StorageClasses, etc.), **not** by bypassing — the validator re-runs on every reconcile.

When the user creates the `Migration`, the per-VM `Builder` constructs each destination `VirtualMachine` CR, virt-v2v (for VMware sources) converts disks and installs drivers, and KubeVirt boots the VM on the destination.

## Calico L2 compatibility (vSphere → OpenShift+Calico)

Forklift supports migrating vSphere VMs onto Calico-backed OpenShift clusters where the destination network is a Calico `projectcalico.org/v3 Network` configured for L2 bridging.

**Admin-managed cluster prerequisites:**

- One or more `Network` CRs with `spec.l2Bridge.vlans[].vlan.id` + `subnets[].cidr` describing each L2 segment.
- `IPPool` CRs whose `spec.cidr` is contained within one of those VLAN subnets — Calico IPAM allocates VM IPs from these.
- A `NetworkAttachmentDefinition` per Calico Network/VLAN combo, with `Spec.Config = {"type":"calico","network":"<name>","vlan":<id>}`. The NAD must live in the Plan's `targetNamespace` or in `default`.

**Forklift behaviour:**

- `Plan.Spec.Map.Network` entries with `destination.type: multus` are followed per-NIC. The destination NAD's `Spec.Config` is parsed; if `type == "calico"` (see `model.NetworkConfig.ReferencesCalicoNetwork()` in `pkg/controller/provider/model/ocp/model.go`), the Calico-specific paths fire.
- **Validation** (`pkg/controller/plan/adapter/vsphere/validator.go::CalicoIssues`) walks each NIC, fetches the named Calico `Network` and the cluster's `IPPool`s, and verifies:
  - The Network exists and has an `l2Bridge` spec.
  - The NAD's VLAN matches one of the Network's VLAN entries (or, for NAD `vlan: 0`, that the Network has exactly one entry).
  - At least one IPPool is fully contained within the matched VLAN's subnet.
  - When `preserveStaticIPs: true`: each NIC's source IP fits the VLAN subnet AND is covered by an eligible IPPool.
  - All findings collapse into a single `CalicoNetworkInvalid` Plan condition with per-VM detail in the Message (see `validation.go::calicoIssueDetail`).
- **Build** (`pkg/controller/plan/adapter/vsphere/builder.go`) stamps two annotations on the destination VM template per Calico-targeting NIC:
  - `cni.projectcalico.org/<iface>.hwAddr` — preserves the source MAC.
  - `cni.projectcalico.org/<iface>.ipAddrs` — preserves the source IPs (only when `preserveStaticIPs: true`).
  The Calico CNI plugin reads these at CNI ADD and asks Calico IPAM for the requested IP from the covering pool; the veth comes up pre-configured.

**Out of scope today:**

- Calico VRF Networks (no `l2Bridge` spec) — flagged with `CalicoNetworkInvalid` and blocked.
- Live migration onto a Calico destination — cold migration only for the L2 path.
- Operator install-time CNI detection — there is no `Provider.Type: calico`; the destination is always `openshift` and Calico-ness is inferred from NAD content.

## Mock testing resources

Forklift's unit tests lean on a handful of shared helpers; reach for these before hand-rolling new fakes.

**Destination-cluster fake (controller-runtime):**

- `pkg/provider/testutil/k8s.go` — `NewScheme()` returns a `runtime.Scheme` pre-registered with `core/v1`, `apps/v1`, `rbac/v1`, and Forklift's `forklift.konveyor.io/v1beta1`. `NewFakeClient(objs...)` wraps `fake.NewClientBuilder()` with that scheme. Use as the default destination `client.Client` in any test that doesn't need custom indexes.
- `pkg/controller/plan/adapter/base/nad_test.go::newFakeClientWithNADs` — fake client preloaded with `NetworkAttachmentDefinition`s; the shape any per-NIC NAD-parse test should use.

- vSphere/vCenter can be mocked using vcsim
- but no mock exists for a kubevirt cluster - the most it has is a fake client, but:
  a cnv.VirtualMachine created against the fake client is an inert YAML blob.
  Nothing produces a corresponding VirtualMachineInstance, nothing launches a pod, no veth gets
  created, no CNI runs, no IPAM happens. So our Calico annotation-emission
  logic can be tested (the annotation lands on the VM template), but the
  annotation actually being read by the Calico CNI plugin is not something
  any test in this repo exercises in-process.
