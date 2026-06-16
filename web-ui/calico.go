package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
)

// Destination-side Calico view. The Forklift inventory does not include Calico
// resources, so we read projectcalico.org/v3 Network and IPPool CRDs directly
// from the cluster the pod runs in. Shapes and the eligibility rule mirror
// pkg/lib/client/calico in the Forklift repo.

type calicoIPPool struct {
	Name string `json:"name"`
	CIDR string `json:"cidr"`
}

type calicoVLAN struct {
	VID           int      `json:"vid"`
	Subnets       []string `json:"subnets"`
	EligiblePools []string `json:"eligiblePools"` // IPPool names contained in Subnets
}

type calicoNetwork struct {
	Name   string       `json:"name"`
	VLANs  []calicoVLAN `json:"vlans"`
	Errors []string     `json:"errors,omitempty"`
}

type calicoData struct {
	Networks []calicoNetwork `json:"networks"`
	IPPools  []calicoIPPool  `json:"ippools"`
	Errors   []string        `json:"errors,omitempty"`
}

// kubeGet fetches a JSON document from the kube API at the given path.
func (p *poller) kubeGet(ctx context.Context, path string) (json.RawMessage, int, error) {
	url := strings.TrimRight(p.cfg.kubeAPI, "/") + "/" + strings.TrimLeft(path, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, 0, err
	}
	if tok := p.token(); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := p.kubeClient.Do(req)
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

// fetchCalico lists Calico IPPools and Networks and derives, per VLAN, which
// pools are eligible (pool CIDR fully contained in a VLAN subnet). Returns nil
// only when neither CRD is reachable AND no data was found — otherwise returns
// a (possibly partial) view with errors recorded. Never fails the snapshot.
func (p *poller) fetchCalico(ctx context.Context) *calicoData {
	cd := &calicoData{Networks: []calicoNetwork{}, IPPools: []calicoIPPool{}}

	pools, status, err := p.listIPPools(ctx)
	if err != nil {
		if status == http.StatusNotFound {
			// CRD not installed — almost certainly not a Calico cluster.
			return nil
		}
		cd.Errors = append(cd.Errors, fmt.Sprintf("ippools: %v", err))
	}
	cd.IPPools = pools

	nets, status, err := p.listNetworks(ctx)
	if err != nil {
		if status == http.StatusNotFound && len(pools) == 0 {
			return nil
		}
		if status != http.StatusNotFound {
			cd.Errors = append(cd.Errors, fmt.Sprintf("networks: %v", err))
		}
	}

	for i := range nets {
		n := &nets[i]
		for j := range n.VLANs {
			v := &n.VLANs[j]
			v.EligiblePools = eligiblePoolNames(pools, v.Subnets)
			if len(v.Subnets) > 0 && len(v.EligiblePools) == 0 {
				n.Errors = append(n.Errors,
					fmt.Sprintf("VLAN %d has no eligible IPPool (no pool CIDR is contained in %v)", v.VID, v.Subnets))
			}
		}
	}
	cd.Networks = nets
	return cd
}

// listType is a minimal Kubernetes list envelope of unstructured items.
type listType struct {
	Items []map[string]any `json:"items"`
}

func (p *poller) listIPPools(ctx context.Context) ([]calicoIPPool, int, error) {
	raw, status, err := p.kubeGet(ctx, "apis/projectcalico.org/v3/ippools")
	if err != nil {
		return []calicoIPPool{}, status, err
	}
	var l listType
	if err := json.Unmarshal(raw, &l); err != nil {
		return []calicoIPPool{}, status, fmt.Errorf("decode ippools: %w", err)
	}
	pools := make([]calicoIPPool, 0, len(l.Items))
	for _, it := range l.Items {
		pools = append(pools, calicoIPPool{
			Name: nestedString(it, "metadata", "name"),
			CIDR: nestedString(it, "spec", "cidr"),
		})
	}
	return pools, status, nil
}

func (p *poller) listNetworks(ctx context.Context) ([]calicoNetwork, int, error) {
	raw, status, err := p.kubeGet(ctx, "apis/projectcalico.org/v3/networks")
	if err != nil {
		return []calicoNetwork{}, status, err
	}
	var l listType
	if err := json.Unmarshal(raw, &l); err != nil {
		return []calicoNetwork{}, status, fmt.Errorf("decode networks: %w", err)
	}
	nets := make([]calicoNetwork, 0, len(l.Items))
	for _, it := range l.Items {
		nets = append(nets, calicoNetwork{
			Name:  nestedString(it, "metadata", "name"),
			VLANs: parseVLANs(it),
		})
	}
	return nets, status, nil
}

// parseVLANs reads spec.l2Bridge.vlans[].{vlan.id, subnets[].cidr}.
func parseVLANs(net map[string]any) []calicoVLAN {
	vlansRaw, _ := nestedSlice(net, "spec", "l2Bridge", "vlans")
	out := []calicoVLAN{}
	for _, v := range vlansRaw {
		m, ok := v.(map[string]any)
		if !ok {
			continue
		}
		entry := calicoVLAN{VID: int(nestedFloat(m, "vlan", "id")), Subnets: []string{}}
		subnets, _ := nestedSlice(m, "subnets")
		for _, s := range subnets {
			sm, ok := s.(map[string]any)
			if !ok {
				continue
			}
			if cidr := nestedString(sm, "cidr"); cidr != "" {
				entry.Subnets = append(entry.Subnets, cidr)
			}
		}
		out = append(out, entry)
	}
	return out
}

// eligiblePoolNames returns the names of pools whose CIDR is fully contained in
// at least one of vlanSubnets.
func eligiblePoolNames(pools []calicoIPPool, vlanSubnets []string) []string {
	out := []string{}
	for _, pool := range pools {
		if poolContainedInAnyVLANSubnet(pool.CIDR, vlanSubnets) {
			out = append(out, pool.Name)
		}
	}
	return out
}

// poolContainedInAnyVLANSubnet reports whether poolCIDR is fully contained
// within one of vlanSubnets. Ported from pkg/lib/client/calico/ippool.go.
func poolContainedInAnyVLANSubnet(poolCIDR string, vlanSubnets []string) bool {
	_, poolNet, err := net.ParseCIDR(poolCIDR)
	if err != nil {
		return false
	}
	poolMaskBits, _ := poolNet.Mask.Size()
	for _, vs := range vlanSubnets {
		_, vlanNet, err := net.ParseCIDR(vs)
		if err != nil {
			continue
		}
		vlanMaskBits, _ := vlanNet.Mask.Size()
		if vlanMaskBits <= poolMaskBits && vlanNet.Contains(poolNet.IP) {
			return true
		}
	}
	return false
}

// --- small unstructured helpers (avoid pulling in k8s apimachinery) ---

func nestedString(m map[string]any, keys ...string) string {
	v := nested(m, keys...)
	s, _ := v.(string)
	return s
}

func nestedFloat(m map[string]any, keys ...string) float64 {
	switch v := nested(m, keys...).(type) {
	case float64:
		return v
	case int:
		return float64(v)
	default:
		return 0
	}
}

func nestedSlice(m map[string]any, keys ...string) ([]any, bool) {
	s, ok := nested(m, keys...).([]any)
	return s, ok
}

func nested(m map[string]any, keys ...string) any {
	var cur any = m
	for _, k := range keys {
		asMap, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = asMap[k]
	}
	return cur
}
