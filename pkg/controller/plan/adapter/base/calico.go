package base

import (
	"context"
	"encoding/json"
	"fmt"

	k8snet "github.com/k8snetworkplumbingwg/network-attachment-definition-client/pkg/apis/k8s.cni.cncf.io/v1"
	model "github.com/kubev2v/forklift/pkg/controller/provider/model/ocp"
	meta "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const (
	CalicoAnnHwAddrFmt = "cni.projectcalico.org/%s.hwAddr"
	CalicoAnnIPsFmt    = "cni.projectcalico.org/%s.ipAddrs"
)

// FetchAndParseNAD GETs the NetworkAttachmentDefinition at namespace/name from
// the destination cluster and unmarshals its Spec.Config into a
// model.NetworkConfig.
// An empty Spec.Config yields a zero-valued NetworkConfig and no error.
func FetchAndParseNAD(ctx context.Context, c client.Client, namespace, name string) (*model.NetworkConfig, error) {
	nad := &k8snet.NetworkAttachmentDefinition{}
	key := client.ObjectKey{Namespace: namespace, Name: name}
	if err := c.Get(ctx, key, nad); err != nil {
		return nil, err
	}
	cfg := &model.NetworkConfig{}
	if nad.Spec.Config == "" {
		return cfg, nil
	}
	if err := json.Unmarshal([]byte(nad.Spec.Config), cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

// SetCalicoMAC writes the cni.projectcalico.org/<ifname>.hwAddr annotation
// onto m. Lazy-inits Annotations when nil.
func SetCalicoMAC(m *meta.ObjectMeta, ifname, mac string) {
	if m.Annotations == nil {
		m.Annotations = map[string]string{}
	}
	m.Annotations[fmt.Sprintf(CalicoAnnHwAddrFmt, ifname)] = mac
}

// SetCalicoStaticIPs JSON-marshals ips and writes the
// cni.projectcalico.org/<ifname>.ipAddrs annotation. No-op when ips is empty.
// Lazy-inits Annotations when nil.
func SetCalicoStaticIPs(m *meta.ObjectMeta, ifname string, ips []string) error {
	if len(ips) == 0 {
		return nil
	}
	encoded, err := json.Marshal(ips)
	if err != nil {
		return err
	}
	if m.Annotations == nil {
		m.Annotations = map[string]string{}
	}
	m.Annotations[fmt.Sprintf(CalicoAnnIPsFmt, ifname)] = string(encoded)
	return nil
}
