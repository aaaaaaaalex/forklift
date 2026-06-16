# Forklift Inventory Web-UI

A small read-only dashboard that visualises the Forklift migration inventory as
an **interactive node graph**. A left sidebar selects an environment (each source
provider, plus the OpenShift/Calico destination); the canvas draws a node per
resource linked by the relationships we derive; clicking a node opens a drawer
with all its fields and any errors correlated to it.

- **Source env:** VM → NIC → Network/Portgroup (VMs flagged when they have a
  Critical validation concern).
- **Destination env:** KubeVirt VM → NAD → Calico Network → IPPool (VMs are the
  migrated `VirtualMachine`s, tied to their NAD via `spec.template.spec.networks`
  multus refs; networks flagged when a VLAN has no eligible IPPool; NADs flagged
  when their network is missing).
- **Migration View** (one per Forklift `Plan`): the end-to-end slice for that
  plan — Plan → its VMs → NICs → source VLAN → (matched by VLAN id) → NAD →
  Calico Network → IPPool — filtered to just the nodes the plan references.
  Clicking the Plan node opens a **live progress pane** derived from
  `Plan.status` (the embedded migration's per-VM phase + pipeline progress); it
  polls `/api/plans` every 5s and updates in place as the migration advances.
- **Live Migrations** (one per KubeVirt `VirtualMachineInstanceMigration`):
  the live migration → its VMI → the **old (source)** and **new (target)**
  placements (virt-launcher pod @ node) from `status.migrationState`.

The graph is rendered with **Cytoscape.js** (MIT) using the **dagre** layout
(left-to-right hierarchy), both vendored under `static/vendor/` and embedded via
`go:embed` — served same-origin with no CDN, so the UI works offline/airgapped.

It runs as a single pod inside the destination cluster. The pod:

1. **Polls** the Forklift inventory service
   (`forklift-inventory.<ns>.svc:8443`) on an interval, authenticating with its
   own ServiceAccount Bearer token.
2. **Crawls the whole inventory** — every provider of every type, plus each
   provider's sub-collections (VMs, networks, hosts, datastores, …).
3. **Keeps the latest snapshot in memory** between polls.
4. **Serves the snapshot unauthenticated** to a browser frontend, which fetches
   it on page load and on demand via a **Reload** button. A **Re-poll now**
   button forces the pod to re-crawl the inventory immediately.

```
 browser ──HTTP(unauth)──▶ web-ui pod ──HTTPS(Bearer token)──▶ forklift-inventory svc
   ▲  reload / re-poll        │  in-memory snapshot                  (SAR: providers)
   └───────── JSON ───────────┘
```

## How it satisfies the requirements

| Requirement | Where |
|---|---|
| Pod consumes the Forklift inventory | `poller.refresh` crawls `/providers` then each provider's sub-resources (`main.go`) |
| RBAC / token to read the *entire* inventory | `ServiceAccount` + cluster-wide `get/list/watch` on `forklift.konveyor.io/providers` (`deploy/manifests.yaml`); token read from the projected SA volume and sent as `Authorization: Bearer` |
| Snapshots kept in memory between polls | `poller.snap` guarded by `sync.RWMutex`, refreshed on `POLL_INTERVAL` |
| Served unauthenticated to the browser | `/api/inventory` (cached) and `/api/refresh` (force poll) — no auth |
| Frontend fetches on load + reload button | `app.js` calls `/api/inventory` on load; **Reload** re-fetches, **Re-poll now** hits `/api/refresh` |

## Why it can read everything

The inventory service authorizes each request with a Kubernetes
SubjectAccessReview against the `providers` resource in the
`forklift.konveyor.io` API group (see
`pkg/controller/provider/web/base/auth.go`). The bundled `ClusterRole` grants
cluster-wide `get`/`list` on that resource, so the SAR passes for providers in
every namespace — the pod sees the full inventory.

## Configuration (environment variables)

| Var | Default | Meaning |
|---|---|---|
| `INVENTORY_URL` | `https://forklift-inventory.konveyor-forklift.svc.cluster.local:8443` | inventory service base URL |
| `POLL_INTERVAL` | `30s` | refresh cadence |
| `LISTEN_ADDR` | `:8080` | dashboard listen address |
| `TOKEN_FILE` | `/var/run/secrets/kubernetes.io/serviceaccount/token` | Bearer token source (or set `TOKEN` directly) |
| `CA_FILE` | `/var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt` | CA bundle to verify the inventory TLS cert |
| `INSECURE_SKIP_VERIFY` | `false` | skip inventory TLS verification (in-cluster traffic) |
| `KUBE_API` | `https://kubernetes.default.svc` | kube API base, used to read Calico Network/IPPool CRDs |
| `KUBE_CA_FILE` | `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` | CA bundle to verify the kube API TLS cert |

## Project layout

```
web-ui/
  main.go, calico.go      Go backend (poller + HTTP server). Embeds static/ via go:embed.
  src/*.ts                Frontend source (TypeScript). Compiled by tsc — no bundler.
    types.ts                shared snapshot/graph types
    graph.ts                pure snapshot -> graph-element transforms (unit-tested)
    app.ts                  DOM glue + Cytoscape rendering + detail drawer
    graph.test.ts           node:test unit tests for the transforms
  static/
    index.html, style.css   served as-is
    vendor/                 vendored Cytoscape + dagre layout (committed, served same-origin)
    app.js, graph.js        GENERATED by `tsc` (git-ignored); embedded into the binary
  package.json, tsconfig*   node/TypeScript tooling
```

The frontend is a **TypeScript node project** built with `tsc` only (no bundler);
it emits native ES modules into `static/`, which the Go binary embeds. Cytoscape
stays vendored. The Go commands target the package `.` (not `./...`) so they
don't descend into `node_modules`.

```bash
cd web-ui
npm install          # one-time: install dev tooling (tsc, eslint, tsx, …)
npm run build        # compile src/*.ts -> static/{app,graph,types}.js
npm test             # unit-test the pure transforms (node:test via tsx)
npm run typecheck    # tsc --noEmit for app + tests
npm run lint         # eslint
```

## Build & push (Makefile)

```bash
cd web-ui
make build          # npm build the frontend, then compile ./bin/flui
make test           # frontend (typecheck/lint/format/test) + backend (go test)
make image          # build the container image (frontend compiled in a node stage)
make push           # build + push to docker.io/projectalexo/flui:latest
```

Override the image coordinates if needed: `make push IMAGE=docker.io/me/flui TAG=v1`.

## Deploy

```bash
make deploy         # kubectl apply -f manifests/manifests.yaml
make port-forward   # forward the ClusterIP service to http://localhost:8080
open http://localhost:8080
```

The install manifest lives in `manifests/manifests.yaml`. The `Service` is a
`ClusterIP` (a stable in-cluster service IP) that you port-forward to reach the
dashboard. On OpenShift, uncomment the `Route` at the bottom of the manifest to
expose it externally instead.

## Run locally against a cluster

```bash
npm run build   # produce static/app.js + static/graph.js (embedded by go run)
TOKEN=$(kubectl -n konveyor-forklift create token forklift-inventory-ui)
kubectl -n konveyor-forklift port-forward svc/forklift-inventory 8443:8443 &

INVENTORY_URL=https://localhost:8443 \
TOKEN="$TOKEN" \
INSECURE_SKIP_VERIFY=true \
go run .
# open http://localhost:8080
```

> **Destination (Calico) graph when running locally:** the Calico
> `Network`/`IPPool` CRDs are read from the **kube API**, not the inventory
> service. `KUBE_API` defaults to `https://kubernetes.default.svc`, which is
> only reachable inside the cluster — so off-cluster the destination graph shows
> every NAD's network as "not found". Point `KUBE_API` at a reachable endpoint,
> e.g. run `kubectl proxy --port=8001` and set `KUBE_API=http://127.0.0.1:8001`
> (the proxy authenticates with your kubeconfig). `make dev` / `make tunnel`
> wire this up automatically.

## Endpoints

| Path | Auth | Description |
|---|---|---|
| `/` | none | dashboard (embedded HTML/CSS/JS) |
| `/api/inventory` | none | latest in-memory snapshot (JSON) |
| `/api/refresh` | none | force an immediate re-crawl, return fresh snapshot |
| `/api/plans` | none | fresh Forklift Plans + migration status (cheap; polled for live progress) |
| `/healthz` | none | liveness/readiness |
