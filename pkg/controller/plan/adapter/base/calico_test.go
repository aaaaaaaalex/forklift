package base

import (
	"context"
	"testing"

	k8snet "github.com/k8snetworkplumbingwg/network-attachment-definition-client/pkg/apis/k8s.cni.cncf.io/v1"
	model "github.com/kubev2v/forklift/pkg/controller/provider/model/ocp"
	k8serr "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func newFakeClientWithNADs(nads ...*k8snet.NetworkAttachmentDefinition) (*fake.ClientBuilder, error) {
	scheme := runtime.NewScheme()
	if err := k8snet.AddToScheme(scheme); err != nil {
		return nil, err
	}
	b := fake.NewClientBuilder().WithScheme(scheme)
	for _, nad := range nads {
		b = b.WithRuntimeObjects(nad)
	}
	return b, nil
}

func TestFetchAndParseNAD(t *testing.T) {
	calicoL2Config := `{"type":"calico","network":"datacenter-vlans","vlan":100,"ipam":{"type":"calico-ipam"}}`
	ovnKConfig := `{"type":"ovn-k8s-cni-overlay","role":"primary","subnets":"10.0.0.0/24","topology":"layer3"}`

	calicoNAD := &k8snet.NetworkAttachmentDefinition{
		ObjectMeta: meta.ObjectMeta{Namespace: "default", Name: "calico-l2"},
		Spec:       k8snet.NetworkAttachmentDefinitionSpec{Config: calicoL2Config},
	}
	ovnNAD := &k8snet.NetworkAttachmentDefinition{
		ObjectMeta: meta.ObjectMeta{Namespace: "default", Name: "ovn-udn"},
		Spec:       k8snet.NetworkAttachmentDefinitionSpec{Config: ovnKConfig},
	}
	emptyConfigNAD := &k8snet.NetworkAttachmentDefinition{
		ObjectMeta: meta.ObjectMeta{Namespace: "default", Name: "empty"},
		Spec:       k8snet.NetworkAttachmentDefinitionSpec{Config: ""},
	}
	malformedNAD := &k8snet.NetworkAttachmentDefinition{
		ObjectMeta: meta.ObjectMeta{Namespace: "default", Name: "broken"},
		Spec:       k8snet.NetworkAttachmentDefinitionSpec{Config: "not json"},
	}

	cb, err := newFakeClientWithNADs(calicoNAD, ovnNAD, emptyConfigNAD, malformedNAD)
	if err != nil {
		t.Fatalf("scheme setup: %v", err)
	}
	c := cb.Build()

	tests := []struct {
		name         string
		namespace    string
		nadName      string
		wantNil      bool
		wantErr      bool
		wantNotFound bool
		check        func(*testing.T, *model.NetworkConfig)
	}{
		{
			name:      "CalicoL2Found",
			namespace: "default",
			nadName:   "calico-l2",
			check: func(t *testing.T, c *model.NetworkConfig) {
				if c.Type != model.CalicoCNIType {
					t.Errorf("Type = %q, want %q", c.Type, model.CalicoCNIType)
				}
				if c.Network != "datacenter-vlans" {
					t.Errorf("Network = %q, want datacenter-vlans", c.Network)
				}
				if c.VLAN != 100 {
					t.Errorf("VLAN = %d, want 100", c.VLAN)
				}
				if !c.ReferencesCalicoNetwork() {
					t.Errorf("ReferencesCalicoNetwork() = false, want true")
				}
			},
		},
		{
			name:      "OvnKFound",
			namespace: "default",
			nadName:   "ovn-udn",
			check: func(t *testing.T, c *model.NetworkConfig) {
				if c.Type != model.OvnOverlayType {
					t.Errorf("Type = %q, want %q", c.Type, model.OvnOverlayType)
				}
				if c.ReferencesCalicoNetwork() {
					t.Errorf("ReferencesCalicoNetwork() = true, want false")
				}
			},
		},
		{
			name:      "EmptyConfigYieldsZeroValueAndNoError",
			namespace: "default",
			nadName:   "empty",
			check: func(t *testing.T, c *model.NetworkConfig) {
				if c.Type != "" || c.Network != "" || c.VLAN != 0 {
					t.Errorf("got non-zero config from empty Spec.Config: %+v", c)
				}
				if c.ReferencesCalicoNetwork() {
					t.Errorf("ReferencesCalicoNetwork() = true on zero config, want false")
				}
			},
		},
		{
			name:         "NotFoundPropagatesAsError",
			namespace:    "default",
			nadName:      "missing",
			wantNil:      true,
			wantErr:      true,
			wantNotFound: true,
		},
		{
			name:      "MalformedJSONReturnsError",
			namespace: "default",
			nadName:   "broken",
			wantNil:   true,
			wantErr:   true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, err := FetchAndParseNAD(context.Background(), c, tt.namespace, tt.nadName)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr = %v", err, tt.wantErr)
			}
			if tt.wantNotFound && !k8serr.IsNotFound(err) {
				t.Errorf("err = %v, want IsNotFound", err)
			}
			if tt.wantNil {
				if cfg != nil {
					t.Errorf("cfg = %+v, want nil", cfg)
				}
				return
			}
			if cfg == nil {
				t.Fatal("cfg = nil, want non-nil")
			}
			if tt.check != nil {
				tt.check(t, cfg)
			}
		})
	}
}

func TestSetCalicoMAC(t *testing.T) {
	tests := []struct {
		name    string
		initial map[string]string
		ifname  string
		mac     string
		wantKey string
		wantVal string
	}{
		{
			name:    "NilAnnotationsLazyInits",
			initial: nil,
			ifname:  "net-0",
			mac:     "aa:bb:cc:dd:ee:ff",
			wantKey: "cni.projectcalico.org/net-0.hwAddr",
			wantVal: "aa:bb:cc:dd:ee:ff",
		},
		{
			name:    "ExistingAnnotationsPreserved",
			initial: map[string]string{"foo": "bar"},
			ifname:  "net-1",
			mac:     "11:22:33:44:55:66",
			wantKey: "cni.projectcalico.org/net-1.hwAddr",
			wantVal: "11:22:33:44:55:66",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := &meta.ObjectMeta{Annotations: tt.initial}
			SetCalicoMAC(m, tt.ifname, tt.mac)
			if got := m.Annotations[tt.wantKey]; got != tt.wantVal {
				t.Errorf("annotations[%q] = %q, want %q", tt.wantKey, got, tt.wantVal)
			}
			if tt.initial != nil {
				if got := m.Annotations["foo"]; got != "bar" {
					t.Errorf("pre-existing annotation lost: %q", got)
				}
			}
		})
	}
}

func TestSetCalicoStaticIPs(t *testing.T) {
	tests := []struct {
		name       string
		initial    map[string]string
		ifname     string
		ips        []string
		wantKey    string
		wantVal    string
		wantMissed bool // when true, expect the key to NOT be present
	}{
		{
			name:    "SingleIP",
			ifname:  "net-0",
			ips:     []string{"10.0.0.5"},
			wantKey: "cni.projectcalico.org/net-0.ipAddrs",
			wantVal: `["10.0.0.5"]`,
		},
		{
			name:    "MultipleIPs",
			ifname:  "net-1",
			ips:     []string{"10.0.0.5", "10.0.0.6"},
			wantKey: "cni.projectcalico.org/net-1.ipAddrs",
			wantVal: `["10.0.0.5","10.0.0.6"]`,
		},
		{
			name:       "EmptySliceIsNoOp",
			ifname:     "net-0",
			ips:        nil,
			wantKey:    "cni.projectcalico.org/net-0.ipAddrs",
			wantMissed: true,
		},
		{
			name:    "ExistingAnnotationsPreserved",
			initial: map[string]string{"foo": "bar"},
			ifname:  "net-0",
			ips:     []string{"10.0.0.5"},
			wantKey: "cni.projectcalico.org/net-0.ipAddrs",
			wantVal: `["10.0.0.5"]`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := &meta.ObjectMeta{Annotations: tt.initial}
			if err := SetCalicoStaticIPs(m, tt.ifname, tt.ips); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			got, present := m.Annotations[tt.wantKey]
			if tt.wantMissed {
				if present {
					t.Errorf("annotations[%q] present = %q, want missing", tt.wantKey, got)
				}
				return
			}
			if got != tt.wantVal {
				t.Errorf("annotations[%q] = %q, want %q", tt.wantKey, got, tt.wantVal)
			}
			if tt.initial != nil {
				if v := m.Annotations["foo"]; v != "bar" {
					t.Errorf("pre-existing annotation lost: %q", v)
				}
			}
		})
	}
}
