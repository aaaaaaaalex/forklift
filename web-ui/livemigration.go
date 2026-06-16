package main

import (
	"context"
	"encoding/json"
	"fmt"
)

// KubeVirt live migrations (VirtualMachineInstanceMigration, kubevirt.io/v1)
// move a running VMI from one node to another. The VMIM's status.migrationState
// carries the source (pre) and target (post) node/pod, which is exactly the
// "old vs new VM resource" the Live Migrations view shows.

type liveMigration struct {
	Namespace  string `json:"namespace"`
	Name       string `json:"name"`
	VMIName    string `json:"vmiName"`
	Phase      string `json:"phase,omitempty"`
	SourceNode string `json:"sourceNode,omitempty"`
	SourcePod  string `json:"sourcePod,omitempty"`
	TargetNode string `json:"targetNode,omitempty"`
	TargetPod  string `json:"targetPod,omitempty"`
	Started    string `json:"started,omitempty"`
	Ended      string `json:"ended,omitempty"`
	Completed  bool   `json:"completed,omitempty"`
	Failed     bool   `json:"failed,omitempty"`
}

// vmiRef is a running KubeVirt VirtualMachineInstance (kubevirt.io/v1). Its name
// matches the VirtualMachine it belongs to.
type vmiRef struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Phase     string `json:"phase,omitempty"`
	Node      string `json:"node,omitempty"`
	UID       string `json:"uid,omitempty"`
}

// launcherPod is the virt-launcher Pod backing a VMI. It is matched to its VM
// via the `vm.kubevirt.io/name` label.
type launcherPod struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	VMName    string `json:"vmName,omitempty"`
	Node      string `json:"node,omitempty"`
	Phase     string `json:"phase,omitempty"`
}

// listVMIs lists KubeVirt VirtualMachineInstances cluster-wide.
func (p *poller) listVMIs(ctx context.Context) ([]vmiRef, int, error) {
	raw, status, err := p.kubeGet(ctx, "apis/kubevirt.io/v1/virtualmachineinstances")
	if err != nil {
		return nil, status, err
	}
	var l listType
	if err := json.Unmarshal(raw, &l); err != nil {
		return nil, status, fmt.Errorf("decode virtualmachineinstances: %w", err)
	}
	out := make([]vmiRef, 0, len(l.Items))
	for _, it := range l.Items {
		out = append(out, vmiRef{
			Namespace: nestedString(it, "metadata", "namespace"),
			Name:      nestedString(it, "metadata", "name"),
			UID:       nestedString(it, "metadata", "uid"),
			Phase:     nestedString(it, "status", "phase"),
			Node:      nestedString(it, "status", "nodeName"),
		})
	}
	return out, status, nil
}

// listLauncherPods lists virt-launcher Pods (those carrying the
// kubevirt.io/created-by label) cluster-wide.
func (p *poller) listLauncherPods(ctx context.Context) ([]launcherPod, int, error) {
	raw, status, err := p.kubeGet(ctx, "api/v1/pods?labelSelector=kubevirt.io/created-by")
	if err != nil {
		return nil, status, err
	}
	var l listType
	if err := json.Unmarshal(raw, &l); err != nil {
		return nil, status, fmt.Errorf("decode pods: %w", err)
	}
	out := make([]launcherPod, 0, len(l.Items))
	for _, it := range l.Items {
		out = append(out, launcherPod{
			Namespace: nestedString(it, "metadata", "namespace"),
			Name:      nestedString(it, "metadata", "name"),
			VMName:    nestedString(it, "metadata", "labels", "vm.kubevirt.io/name"),
			Node:      nestedString(it, "spec", "nodeName"),
			Phase:     nestedString(it, "status", "phase"),
		})
	}
	return out, status, nil
}

// listLiveMigrations lists VirtualMachineInstanceMigrations cluster-wide,
// returning status/error so the caller can explain an empty list.
func (p *poller) listLiveMigrations(ctx context.Context) ([]liveMigration, int, error) {
	raw, status, err := p.kubeGet(ctx, "apis/kubevirt.io/v1/virtualmachineinstancemigrations")
	if err != nil {
		return nil, status, err
	}
	var l listType
	if err := json.Unmarshal(raw, &l); err != nil {
		return nil, status, fmt.Errorf("decode virtualmachineinstancemigrations: %w", err)
	}
	out := make([]liveMigration, 0, len(l.Items))
	for _, it := range l.Items {
		lm := liveMigration{
			Namespace:  nestedString(it, "metadata", "namespace"),
			Name:       nestedString(it, "metadata", "name"),
			VMIName:    nestedString(it, "spec", "vmiName"),
			Phase:      nestedString(it, "status", "phase"),
			SourceNode: nestedString(it, "status", "migrationState", "sourceNode"),
			SourcePod:  nestedString(it, "status", "migrationState", "sourcePod"),
			TargetNode: nestedString(it, "status", "migrationState", "targetNode"),
			TargetPod:  nestedString(it, "status", "migrationState", "targetPod"),
			Started:    nestedString(it, "status", "migrationState", "startTimestamp"),
			Ended:      nestedString(it, "status", "migrationState", "endTimestamp"),
		}
		if b, ok := nested(it, "status", "migrationState", "completed").(bool); ok {
			lm.Completed = b
		}
		if b, ok := nested(it, "status", "migrationState", "failed").(bool); ok {
			lm.Failed = b
		}
		out = append(out, lm)
	}
	return out, status, nil
}
