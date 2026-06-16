package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// fakeInventory mimics the Forklift inventory routes the crawler walks.
func fakeInventory(t *testing.T) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/providers", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{
			"vsphere": [{"name":"vc01","namespace":"konveyor-forklift","uid":"u-1","selfLink":"/providers/vsphere/u-1","type":"vsphere","vmCount":2,"networkCount":1,"object":{"kind":"Provider"}}],
			"openshift": [{"name":"host","namespace":"konveyor-forklift","uid":"u-2","selfLink":"/providers/openshift/u-2","type":"openshift","object":{}}],
			"ovirt": [], "openstack": [], "ova": [], "ec2": [], "hyperv": []
		}`))
	})
	mux.HandleFunc("/providers/vsphere/u-1/vms", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`[{"name":"web-vm","uid":"vm-1","powerState":"poweredOn"},{"name":"db-vm","uid":"vm-2","powerState":"poweredOff"}]`))
	})
	mux.HandleFunc("/providers/vsphere/u-1/networks", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`[{"name":"VM Network","uid":"net-1"}]`))
	})
	// Everything else 404s — the crawler must tolerate that silently.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	return httptest.NewServer(mux)
}

func TestRefreshCrawlsInventory(t *testing.T) {
	srv := fakeInventory(t)
	defer srv.Close()

	p, err := newPoller(config{inventoryURL: srv.URL, insecure: true, tokenFile: "/nonexistent"})
	if err != nil {
		t.Fatal(err)
	}
	snap := p.refresh(context.Background())

	if !snap.OK {
		t.Fatalf("expected OK snapshot, got errors: %v", snap.Errors)
	}
	if len(snap.Providers) != 2 {
		t.Fatalf("expected 2 providers, got %d", len(snap.Providers))
	}

	var vsphere *providerEntry
	for i := range snap.Providers {
		if snap.Providers[i].Type == "vsphere" {
			vsphere = &snap.Providers[i]
		}
	}
	if vsphere == nil {
		t.Fatal("vsphere provider not found")
	}
	if got := vsphere.Counts["vms"]; got != 2 {
		t.Errorf("expected 2 vms, got %d", got)
	}
	if got := vsphere.Counts["networks"]; got != 1 {
		t.Errorf("expected 1 network, got %d", got)
	}
	if _, ok := vsphere.Resources["vms"]; !ok {
		t.Error("vms resource payload missing")
	}
	if len(vsphere.Errors) != 0 {
		t.Errorf("unexpected per-provider errors (404s should be silent): %v", vsphere.Errors)
	}

	// The stored snapshot must be retrievable.
	p.store(snap)
	if p.latest() != snap {
		t.Error("latest() did not return stored snapshot")
	}
}

func TestRefreshHandlesUnreachableInventory(t *testing.T) {
	p, _ := newPoller(config{inventoryURL: "https://127.0.0.1:1", insecure: true, tokenFile: "/nonexistent"})
	snap := p.refresh(context.Background())
	if snap.OK {
		t.Fatal("expected failed snapshot for unreachable inventory")
	}
	if len(snap.Errors) == 0 {
		t.Fatal("expected error message on failed snapshot")
	}
}

func TestServeCachedSnapshot(t *testing.T) {
	p, _ := newPoller(config{inventoryURL: "http://x", insecure: true, tokenFile: "/nonexistent"})
	p.store(&snapshot{OK: true, FetchedAt: time.Now(), Providers: []providerEntry{}})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/inventory", nil)
	http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s := p.latest()
		writeJSON(w, http.StatusOK, s)
	}).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var out snapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("response not valid JSON: %v", err)
	}
	if !out.OK {
		t.Error("expected ok=true in served snapshot")
	}
}
