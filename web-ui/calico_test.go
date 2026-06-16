package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPoolContainedInAnyVLANSubnet(t *testing.T) {
	cases := []struct {
		name    string
		pool    string
		subnets []string
		want    bool
	}{
		{"contained", "10.0.1.0/24", []string{"10.0.0.0/16"}, true},
		{"equal", "10.0.0.0/16", []string{"10.0.0.0/16"}, true},
		{"not contained", "10.1.0.0/24", []string{"10.0.0.0/24"}, false},
		{"pool wider than subnet", "10.0.0.0/8", []string{"10.0.0.0/16"}, false},
		{"second subnet matches", "192.168.5.0/24", []string{"10.0.0.0/16", "192.168.0.0/16"}, true},
		{"bad pool cidr", "not-a-cidr", []string{"10.0.0.0/16"}, false},
		{"no subnets", "10.0.0.0/24", nil, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := poolContainedInAnyVLANSubnet(c.pool, c.subnets); got != c.want {
				t.Errorf("poolContainedInAnyVLANSubnet(%q, %v) = %v, want %v", c.pool, c.subnets, got, c.want)
			}
		})
	}
}

// fakeKube serves the two Calico CRD list endpoints.
func fakeKube(ippools, networks string) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/apis/projectcalico.org/v3/ippools", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(ippools))
	})
	mux.HandleFunc("/apis/projectcalico.org/v3/networks", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(networks))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	return httptest.NewServer(mux)
}

func TestFetchCalicoEligibility(t *testing.T) {
	ippools := `{"items":[
		{"metadata":{"name":"pool-vlan10"},"spec":{"cidr":"10.0.10.0/24"}},
		{"metadata":{"name":"pool-other"},"spec":{"cidr":"172.16.0.0/16"}}
	]}`
	networks := `{"items":[
		{"metadata":{"name":"vlan10"},"spec":{"l2Bridge":{"vlans":[
			{"vlan":{"id":10},"subnets":[{"cidr":"10.0.0.0/16"}]}
		]}}},
		{"metadata":{"name":"vlan99"},"spec":{"l2Bridge":{"vlans":[
			{"vlan":{"id":99},"subnets":[{"cidr":"10.99.0.0/16"}]}
		]}}}
	]}`
	srv := fakeKube(ippools, networks)
	defer srv.Close()

	p, _ := newPoller(config{kubeAPI: srv.URL, insecure: true, tokenFile: "/nonexistent"})
	cd := p.fetchCalico(context.Background())
	if cd == nil {
		t.Fatal("expected calico data, got nil")
	}
	if len(cd.IPPools) != 2 || len(cd.Networks) != 2 {
		t.Fatalf("expected 2 pools / 2 networks, got %d / %d", len(cd.IPPools), len(cd.Networks))
	}

	byName := map[string]calicoNetwork{}
	for _, n := range cd.Networks {
		byName[n.Name] = n
	}
	// vlan10's subnet 10.0.0.0/16 contains pool-vlan10 (10.0.10.0/24) but not pool-other.
	v10 := byName["vlan10"].VLANs[0]
	if len(v10.EligiblePools) != 1 || v10.EligiblePools[0] != "pool-vlan10" {
		t.Errorf("vlan10 eligible pools = %v, want [pool-vlan10]", v10.EligiblePools)
	}
	if len(byName["vlan10"].Errors) != 0 {
		t.Errorf("vlan10 should have no errors, got %v", byName["vlan10"].Errors)
	}
	// vlan99's subnet 10.99.0.0/16 contains no pool → error.
	if len(byName["vlan99"].VLANs[0].EligiblePools) != 0 {
		t.Errorf("vlan99 should have no eligible pools, got %v", byName["vlan99"].VLANs[0].EligiblePools)
	}
	if len(byName["vlan99"].Errors) == 0 {
		t.Error("vlan99 should report a no-eligible-pool error")
	}
}

func TestFetchCalicoAbsent(t *testing.T) {
	// A cluster without the Calico CRDs: both endpoints 404.
	srv := fakeKube("", "")
	srv.Close() // force connection errors as a stand-in for unreachable
	p, _ := newPoller(config{kubeAPI: srv.URL, insecure: true, tokenFile: "/nonexistent"})
	// Should not panic; returns a data block with errors recorded (not nil here
	// because connection refused != 404). The snapshot must still be usable.
	cd := p.fetchCalico(context.Background())
	if cd != nil && cd.Errors == nil && len(cd.IPPools) > 0 {
		t.Error("unexpected pools from a closed server")
	}
}

// TestRefreshIncludesCalico proves the full refresh() wires the Calico block
// into the snapshot the frontend receives, without failing on the crawl.
func TestRefreshIncludesCalico(t *testing.T) {
	inv := fakeInventory(t)
	defer inv.Close()
	kube := fakeKube(
		`{"items":[{"metadata":{"name":"p1"},"spec":{"cidr":"10.0.1.0/24"}}]}`,
		`{"items":[{"metadata":{"name":"vlan10"},"spec":{"l2Bridge":{"vlans":[{"vlan":{"id":10},"subnets":[{"cidr":"10.0.0.0/16"}]}]}}}]}`,
	)
	defer kube.Close()

	p, _ := newPoller(config{inventoryURL: inv.URL, kubeAPI: kube.URL, insecure: true, tokenFile: "/nonexistent"})
	snap := p.refresh(context.Background())

	if !snap.OK {
		t.Fatalf("snapshot not OK: %v", snap.Errors)
	}
	if snap.Calico == nil {
		t.Fatal("expected snap.Calico to be populated")
	}
	if len(snap.Calico.Networks) != 1 || snap.Calico.Networks[0].VLANs[0].EligiblePools[0] != "p1" {
		t.Errorf("calico not wired correctly: %+v", snap.Calico)
	}
}

func TestFetchPlans(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/apis/forklift.konveyor.io/v1beta1/plans", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"items":[
			{"metadata":{"name":"migrate-app","namespace":"openshift-mtv"},
			 "spec":{"vms":[{"id":"vm-29","name":"photon-01"},{"id":"vm-18","name":"vcenter"}]},
			 "status":{
			   "conditions":[{"type":"Executing","status":"True","category":"Advisory","message":"Running"}],
			   "migration":{"started":"2026-06-10T10:00:00Z","vms":[
			     {"id":"vm-29","name":"photon-01","phase":"CopyingDisks","started":"2026-06-10T10:00:05Z",
			      "pipeline":[{"name":"DiskTransfer","phase":"Running","progress":{"completed":40,"total":100}}]}
			   ]}
			 }}
		]}`))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	srv := httptest.NewServer(mux)
	defer srv.Close()

	p, _ := newPoller(config{kubeAPI: srv.URL, insecure: true, tokenFile: "/nonexistent"})
	plans := p.fetchPlans(context.Background())
	if len(plans) != 1 {
		t.Fatalf("expected 1 plan, got %d", len(plans))
	}
	if plans[0].Name != "migrate-app" || plans[0].Namespace != "openshift-mtv" {
		t.Errorf("unexpected plan identity: %+v", plans[0])
	}
	if len(plans[0].VMs) != 2 || plans[0].VMs[0].ID != "vm-29" || plans[0].VMs[1].Name != "vcenter" {
		t.Errorf("unexpected plan VMs: %+v", plans[0].VMs)
	}
	st := plans[0].Status
	if st == nil {
		t.Fatal("expected plan status to be parsed")
	}
	if len(st.Conditions) != 1 || st.Conditions[0].Type != "Executing" || st.Conditions[0].Status != "True" {
		t.Errorf("unexpected conditions: %+v", st.Conditions)
	}
	if len(st.VMs) != 1 || st.VMs[0].Phase != "CopyingDisks" {
		t.Fatalf("unexpected status VMs: %+v", st.VMs)
	}
	if len(st.VMs[0].Pipeline) != 1 || st.VMs[0].Pipeline[0].Completed != 40 || st.VMs[0].Pipeline[0].Total != 100 {
		t.Errorf("unexpected pipeline: %+v", st.VMs[0].Pipeline)
	}
}

func TestListLiveMigrations(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/apis/kubevirt.io/v1/virtualmachineinstancemigrations", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"items":[
			{"metadata":{"name":"lm-vm0","namespace":"migration-target"},
			 "spec":{"vmiName":"dc0-h0-vm0"},
			 "status":{"phase":"Succeeded","migrationState":{
			   "completed":true,"sourceNode":"kind-worker2","sourcePod":"virt-launcher-src",
			   "targetNode":"kind-worker","targetPod":"virt-launcher-tgt"}}}
		]}`))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	srv := httptest.NewServer(mux)
	defer srv.Close()

	p, _ := newPoller(config{kubeAPI: srv.URL, insecure: true, tokenFile: "/nonexistent"})
	lms, _, err := p.listLiveMigrations(context.Background())
	if err != nil || len(lms) != 1 {
		t.Fatalf("expected 1 live migration, got %d (err %v)", len(lms), err)
	}
	lm := lms[0]
	if lm.VMIName != "dc0-h0-vm0" || lm.Phase != "Succeeded" || !lm.Completed {
		t.Errorf("unexpected: %+v", lm)
	}
	if lm.SourceNode != "kind-worker2" || lm.TargetNode != "kind-worker" || lm.SourcePod != "virt-launcher-src" || lm.TargetPod != "virt-launcher-tgt" {
		t.Errorf("unexpected migrationState mapping: %+v", lm)
	}
}

func TestListVMIsAndLauncherPods(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/apis/kubevirt.io/v1/virtualmachineinstances", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"items":[
			{"metadata":{"name":"dc0-h0-vm0","namespace":"migration-target","uid":"vmi-uid"},
			 "status":{"phase":"Running","nodeName":"kind-worker2"}}
		]}`))
	})
	mux.HandleFunc("/api/v1/pods", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("labelSelector") != "kubevirt.io/created-by" {
			t.Errorf("unexpected labelSelector: %q", r.URL.Query().Get("labelSelector"))
		}
		_, _ = w.Write([]byte(`{"items":[
			{"metadata":{"name":"virt-launcher-dc0-h0-vm0-m4xwn","namespace":"migration-target",
			   "labels":{"kubevirt.io":"virt-launcher","vm.kubevirt.io/name":"dc0-h0-vm0"}},
			 "spec":{"nodeName":"kind-worker2"},"status":{"phase":"Running"}}
		]}`))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	srv := httptest.NewServer(mux)
	defer srv.Close()

	p, _ := newPoller(config{kubeAPI: srv.URL, insecure: true, tokenFile: "/nonexistent"})
	vmis, _, err := p.listVMIs(context.Background())
	if err != nil || len(vmis) != 1 || vmis[0].Name != "dc0-h0-vm0" || vmis[0].Node != "kind-worker2" {
		t.Fatalf("unexpected VMIs: %+v (err %v)", vmis, err)
	}
	pods, _, err := p.listLauncherPods(context.Background())
	if err != nil || len(pods) != 1 {
		t.Fatalf("unexpected pods: %+v (err %v)", pods, err)
	}
	if pods[0].Name != "virt-launcher-dc0-h0-vm0-m4xwn" || pods[0].VMName != "dc0-h0-vm0" || pods[0].Node != "kind-worker2" {
		t.Errorf("unexpected launcher pod mapping: %+v", pods[0])
	}
}

func TestFetchPlansAbsentReturnsNil(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	p, _ := newPoller(config{kubeAPI: srv.URL, insecure: true, tokenFile: "/nonexistent"})
	if plans := p.fetchPlans(context.Background()); plans != nil {
		t.Errorf("expected nil plans when CRD absent, got %+v", plans)
	}
}

func TestFetchCalico404ReturnsNil(t *testing.T) {
	// Server that 404s everything (CRDs not installed).
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	p, _ := newPoller(config{kubeAPI: srv.URL, insecure: true, tokenFile: "/nonexistent"})
	if cd := p.fetchCalico(context.Background()); cd != nil {
		t.Errorf("expected nil calico data when CRDs are absent, got %+v", cd)
	}
}
