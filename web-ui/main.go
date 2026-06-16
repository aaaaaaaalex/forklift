// Command web-ui is a small read-only dashboard for the Forklift inventory.
//
// It runs as a pod inside the destination cluster, polls the Forklift
// inventory service (forklift-inventory.<ns>.svc:8443) on an interval using
// its own ServiceAccount token, and keeps the most recent snapshot in memory.
// The snapshot is served, unauthenticated, to a browser frontend that fetches
// it on load and on demand via a reload button.
//
// All configuration is via environment variables; see the consts below.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed static
var staticFS embed.FS

// config is resolved once at startup from the environment.
type config struct {
	inventoryURL string        // base URL of the Forklift inventory service
	listenAddr   string        // address the dashboard listens on
	pollInterval time.Duration // how often to refresh the snapshot
	tokenFile    string        // ServiceAccount token used as Bearer for the inventory
	caFile       string        // CA bundle used to verify the inventory's TLS cert
	insecure     bool          // skip inventory TLS verification
	kubeAPI      string        // Kubernetes API base (for Calico CRDs on the destination)
	kubeCAFile   string        // CA bundle used to verify the kube API TLS cert
}

func loadConfig() config {
	return config{
		inventoryURL: env("INVENTORY_URL", "https://forklift-inventory.konveyor-forklift.svc.cluster.local:8443"),
		listenAddr:   env("LISTEN_ADDR", ":8080"),
		pollInterval: envDuration("POLL_INTERVAL", 30*time.Second),
		tokenFile:    env("TOKEN_FILE", "/var/run/secrets/kubernetes.io/serviceaccount/token"),
		caFile:       env("CA_FILE", "/var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt"),
		insecure:     envBool("INSECURE_SKIP_VERIFY", false),
		kubeAPI:      env("KUBE_API", "https://kubernetes.default.svc"),
		kubeCAFile:   env("KUBE_CA_FILE", "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	if v := os.Getenv(key); v != "" {
		b, err := strconv.ParseBool(v)
		if err == nil {
			return b
		}
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		d, err := time.ParseDuration(v)
		if err == nil {
			return d
		}
	}
	return def
}

// subResources lists, per provider type, the inventory sub-collections worth
// crawling. Anything that 404s for a given provider is silently skipped, so it
// is safe to be generous here across Forklift versions.
var subResources = map[string][]string{
	"vsphere":   {"datacenters", "clusters", "hosts", "networks", "datastores", "vms", "folders"},
	"ovirt":     {"datacenters", "clusters", "hosts", "networks", "storagedomains", "disks", "vms", "nicprofiles", "diskprofiles"},
	"openshift": {"namespaces", "networkattachmentdefinitions", "storageclasses", "vms", "persistentvolumeclaims", "datavolumes"},
	"openstack": {"regions", "projects", "images", "flavors", "volumes", "volumetypes", "networks", "subnets", "vms"},
	"ova":       {"vms", "networks", "disks", "storages"},
	"ec2":       {"vms", "networks", "volumes"},
	"hyperv":    {"vms", "networks", "disks"},
}

// providerEntry is one source/destination provider plus its crawled children.
type providerEntry struct {
	Type      string                     `json:"type"`
	Name      string                     `json:"name"`
	Namespace string                     `json:"namespace"`
	UID       string                     `json:"uid"`
	SelfLink  string                     `json:"selfLink"`
	Object    json.RawMessage            `json:"object"`
	Counts    map[string]int             `json:"counts"`
	Resources map[string]json.RawMessage `json:"resources"`
	Errors    []string                   `json:"errors,omitempty"`
}

// snapshot is the in-memory view served to the frontend.
type snapshot struct {
	FetchedAt      time.Time       `json:"fetchedAt"`
	DurationMs     int64           `json:"durationMs"`
	InventoryURL   string          `json:"inventoryUrl"`
	Providers      []providerEntry `json:"providers"`
	Calico         *calicoData     `json:"calico,omitempty"`
	Plans          []planRef       `json:"plans,omitempty"`
	PlansError     string          `json:"plansError,omitempty"`
	LiveMigrations []liveMigration `json:"liveMigrations,omitempty"`
	VMIs           []vmiRef        `json:"vmis,omitempty"`
	LauncherPods   []launcherPod   `json:"launcherPods,omitempty"`
	Errors         []string        `json:"errors,omitempty"`
	OK             bool            `json:"ok"`
}

// poller owns the inventory client and the latest snapshot.
type poller struct {
	cfg        config
	client     *http.Client // talks to the Forklift inventory service
	kubeClient *http.Client // talks to the kube API for Calico CRDs

	mu   sync.RWMutex
	snap *snapshot
}

func newPoller(cfg config) (*poller, error) {
	tlsConf := &tls.Config{InsecureSkipVerify: cfg.insecure}
	if !cfg.insecure {
		if ca, err := os.ReadFile(cfg.caFile); err == nil {
			pool := x509.NewCertPool()
			if pool.AppendCertsFromPEM(ca) {
				tlsConf.RootCAs = pool
			} else {
				log.Printf("warning: CA file %s contained no usable certs", cfg.caFile)
			}
		} else {
			log.Printf("warning: could not read CA file %s (%v); set INSECURE_SKIP_VERIFY=true to skip verification", cfg.caFile, err)
		}
	}
	// Separate client for the kube API: verify against the kube API CA
	// (the SA's ca.crt), independent of the inventory TLS settings.
	kubeTLS := &tls.Config{InsecureSkipVerify: cfg.insecure}
	if !cfg.insecure {
		if ca, err := os.ReadFile(cfg.kubeCAFile); err == nil {
			pool := x509.NewCertPool()
			if pool.AppendCertsFromPEM(ca) {
				kubeTLS.RootCAs = pool
			}
		}
	}
	return &poller{
		cfg: cfg,
		client: &http.Client{
			Timeout:   30 * time.Second,
			Transport: &http.Transport{TLSClientConfig: tlsConf},
		},
		kubeClient: &http.Client{
			Timeout:   30 * time.Second,
			Transport: &http.Transport{TLSClientConfig: kubeTLS},
		},
	}, nil
}

func (p *poller) token() string {
	if t := os.Getenv("TOKEN"); t != "" {
		return strings.TrimSpace(t)
	}
	if b, err := os.ReadFile(p.cfg.tokenFile); err == nil {
		return strings.TrimSpace(string(b))
	}
	return ""
}

// get fetches a JSON document from the inventory at the given path.
func (p *poller) get(ctx context.Context, path string) (json.RawMessage, int, error) {
	url := strings.TrimRight(p.cfg.inventoryURL, "/") + "/" + strings.TrimLeft(path, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, 0, err
	}
	if tok := p.token(); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, fmt.Errorf("GET %s: %s", path, resp.Status)
	}
	return json.RawMessage(body), resp.StatusCode, nil
}

// refresh crawls the whole inventory and replaces the stored snapshot.
func (p *poller) refresh(ctx context.Context) *snapshot {
	start := time.Now()
	snap := &snapshot{
		FetchedAt:    start,
		InventoryURL: p.cfg.inventoryURL,
		Providers:    []providerEntry{},
		OK:           true,
	}

	// /providers returns {"<type>": [ {provider}, ... ], ...}
	raw, _, err := p.get(ctx, "providers?detail=1")
	if err != nil {
		snap.OK = false
		snap.Errors = append(snap.Errors, fmt.Sprintf("list providers: %v", err))
		snap.DurationMs = time.Since(start).Milliseconds()
		return snap
	}

	var byType map[string][]struct {
		Name      string          `json:"name"`
		Namespace string          `json:"namespace"`
		UID       string          `json:"uid"`
		SelfLink  string          `json:"selfLink"`
		Type      string          `json:"type"`
		Object    json.RawMessage `json:"object"`
		// counts (present per provider type at detail>=1)
		VMCount       int `json:"vmCount"`
		NetworkCount  int `json:"networkCount"`
		HostCount     int `json:"hostCount"`
		DatastoreV    int `json:"datastoreCount"`
		ClusterCount  int `json:"clusterCount"`
		StorageClassC int `json:"storageClassCount"`
	}
	if err := json.Unmarshal(raw, &byType); err != nil {
		snap.OK = false
		snap.Errors = append(snap.Errors, fmt.Sprintf("decode providers: %v", err))
		snap.DurationMs = time.Since(start).Milliseconds()
		return snap
	}

	for ptype, list := range byType {
		for _, pr := range list {
			entry := providerEntry{
				Type:      ptype,
				Name:      pr.Name,
				Namespace: pr.Namespace,
				UID:       pr.UID,
				SelfLink:  pr.SelfLink,
				Object:    pr.Object,
				Counts:    map[string]int{},
				Resources: map[string]json.RawMessage{},
			}
			if pr.VMCount > 0 {
				entry.Counts["vms"] = pr.VMCount
			}
			if pr.NetworkCount > 0 {
				entry.Counts["networks"] = pr.NetworkCount
			}
			if pr.HostCount > 0 {
				entry.Counts["hosts"] = pr.HostCount
			}

			base := pr.SelfLink
			if base == "" {
				base = fmt.Sprintf("providers/%s/%s", ptype, pr.UID)
			}
			for _, sub := range subResources[ptype] {
				doc, status, err := p.get(ctx, strings.TrimLeft(base, "/")+"/"+sub+"?detail=1")
				if err != nil {
					if status != http.StatusNotFound && status != 0 {
						entry.Errors = append(entry.Errors, fmt.Sprintf("%s: %v", sub, err))
					}
					continue
				}
				entry.Resources[sub] = doc
				entry.Counts[sub] = countArray(doc)
			}
			snap.Providers = append(snap.Providers, entry)
		}
	}

	// Destination-side: Calico Network + IPPool CRDs from the local cluster.
	// Tolerated as best-effort; absence/404 must not fail the snapshot.
	snap.Calico = p.fetchCalico(ctx)

	// Forklift Migration Plans (CRDs), for the Migration View. Best-effort, but
	// we record the reason on failure so the UI can explain an empty list
	// (404 = CRD/feature absent, 403 = missing RBAC, dial error = KUBE_API).
	if plans, status, err := p.listPlans(ctx); err != nil {
		snap.PlansError = err.Error()
		log.Printf("fetch plans failed (status %d): %v", status, err)
	} else {
		snap.Plans = plans
		log.Printf("fetched %d plan(s)", len(plans))
	}

	// KubeVirt live migrations (VirtualMachineInstanceMigration). Best-effort.
	if lms, status, err := p.listLiveMigrations(ctx); err != nil {
		log.Printf("fetch live migrations failed (status %d): %v", status, err)
	} else {
		snap.LiveMigrations = lms
		log.Printf("fetched %d live migration(s)", len(lms))
	}

	// KubeVirt VMIs + their virt-launcher pods, so a destination VM expands to
	// VM -> VMI -> launcher pod. Best-effort.
	if vmis, status, err := p.listVMIs(ctx); err != nil {
		log.Printf("fetch VMIs failed (status %d): %v", status, err)
	} else {
		snap.VMIs = vmis
	}
	if pods, status, err := p.listLauncherPods(ctx); err != nil {
		log.Printf("fetch launcher pods failed (status %d): %v", status, err)
	} else {
		snap.LauncherPods = pods
	}

	snap.DurationMs = time.Since(start).Milliseconds()
	return snap
}

// countArray returns the number of elements if doc is a JSON array, else 0.
func countArray(doc json.RawMessage) int {
	var arr []json.RawMessage
	if err := json.Unmarshal(doc, &arr); err == nil {
		return len(arr)
	}
	return 0
}

func (p *poller) store(s *snapshot) {
	p.mu.Lock()
	p.snap = s
	p.mu.Unlock()
}

func (p *poller) latest() *snapshot {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.snap
}

// run does an initial refresh, then refreshes on the configured interval until
// ctx is cancelled.
func (p *poller) run(ctx context.Context) {
	p.store(p.refresh(ctx))
	logSnap(p.latest())
	ticker := time.NewTicker(p.cfg.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s := p.refresh(ctx)
			p.store(s)
			logSnap(s)
		}
	}
}

func logSnap(s *snapshot) {
	if s == nil {
		return
	}
	if s.OK {
		log.Printf("snapshot: %d providers in %dms", len(s.Providers), s.DurationMs)
	} else {
		log.Printf("snapshot FAILED in %dms: %v", s.DurationMs, s.Errors)
	}
}

func main() {
	cfg := loadConfig()
	log.Printf("forklift inventory web-ui starting: inventory=%s poll=%s listen=%s insecure=%v",
		cfg.inventoryURL, cfg.pollInterval, cfg.listenAddr, cfg.insecure)

	p, err := newPoller(cfg)
	if err != nil {
		log.Fatalf("init: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.run(ctx)

	mux := http.NewServeMux()

	// Cached snapshot — what the reload button fetches.
	mux.HandleFunc("/api/inventory", func(w http.ResponseWriter, r *http.Request) {
		s := p.latest()
		if s == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "no snapshot yet"})
			return
		}
		writeJSON(w, http.StatusOK, s)
	})

	// Force an immediate re-poll, then return the fresh snapshot.
	mux.HandleFunc("/api/refresh", func(w http.ResponseWriter, r *http.Request) {
		rctx, c := context.WithTimeout(r.Context(), 60*time.Second)
		defer c()
		s := p.refresh(rctx)
		p.store(s)
		logSnap(s)
		writeJSON(w, http.StatusOK, s)
	})

	// Cheap, always-fresh plan list (one kube list) so the Migration View can
	// poll migration progress without re-crawling the whole inventory.
	mux.HandleFunc("/api/plans", func(w http.ResponseWriter, r *http.Request) {
		rctx, c := context.WithTimeout(r.Context(), 15*time.Second)
		defer c()
		plans, status, err := p.listPlans(rctx)
		resp := map[string]any{"plans": plans}
		if err != nil {
			resp["error"] = err.Error()
			resp["status"] = status
		}
		writeJSON(w, http.StatusOK, resp)
	})

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	})

	// Static frontend (embedded). Serve index.html at "/". The assets are
	// rebuilt+re-embedded on every release, so tell the browser to revalidate
	// (no-cache) rather than serve a stale app.js after a redeploy.
	sub, _ := fsSub()
	static := http.FileServer(http.FS(sub))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		static.ServeHTTP(w, r)
	}))

	log.Printf("listening on %s", cfg.listenAddr)
	if err := http.ListenAndServe(cfg.listenAddr, mux); err != nil {
		log.Fatalf("serve: %v", err)
	}
}

// fsSub returns the embedded static dir rooted so index.html is served at "/".
func fsSub() (fs.FS, error) {
	return fs.Sub(staticFS, "static")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
