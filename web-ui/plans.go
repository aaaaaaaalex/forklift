package main

import (
	"context"
	"encoding/json"
	"fmt"
)

// Forklift Migration Plans are CRDs (forklift.konveyor.io/v1beta1), not part of
// the provider inventory, so — like the Calico CRDs — we read them from the
// kube API. We keep the plan identity, its VM references (matched to inventory
// VMs by id/name in the frontend), and its migration status/progress
// (Plan.status.migration embeds the running Migration's per-VM pipeline).

type planVM struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// planStep is one pipeline step of a VM's migration (Plan.status.migration.vms[].pipeline[]).
type planStep struct {
	Name      string `json:"name"`
	Phase     string `json:"phase,omitempty"`
	Completed int64  `json:"completed"`
	Total     int64  `json:"total"`
}

// planVMStatus is the live migration status of one VM.
type planVMStatus struct {
	ID        string     `json:"id,omitempty"`
	Name      string     `json:"name,omitempty"`
	Phase     string     `json:"phase,omitempty"`
	Started   string     `json:"started,omitempty"`
	Completed string     `json:"completed,omitempty"`
	Pipeline  []planStep `json:"pipeline,omitempty"`
	Error     []string   `json:"error,omitempty"`
}

type planCondition struct {
	Type     string `json:"type"`
	Status   string `json:"status"`
	Category string `json:"category,omitempty"`
	Message  string `json:"message,omitempty"`
}

// planStatus is the slice of Plan.status the Migration View progress pane needs.
type planStatus struct {
	Conditions []planCondition `json:"conditions,omitempty"`
	Started    string          `json:"started,omitempty"`
	Completed  string          `json:"completed,omitempty"`
	VMs        []planVMStatus  `json:"vms,omitempty"`
}

type planRef struct {
	Name      string      `json:"name"`
	Namespace string      `json:"namespace"`
	VMs       []planVM    `json:"vms"`
	Status    *planStatus `json:"status,omitempty"`
}

// fetchPlans is the error-swallowing convenience wrapper around listPlans.
func (p *poller) fetchPlans(ctx context.Context) []planRef {
	plans, _, _ := p.listPlans(ctx)
	return plans
}

// listPlans lists Forklift Plans cluster-wide and returns the HTTP status and
// any error so callers can surface *why* there are no plans (CRD absent → 404,
// missing RBAC → 403, kube API unreachable → connection error).
func (p *poller) listPlans(ctx context.Context) ([]planRef, int, error) {
	raw, status, err := p.kubeGet(ctx, "apis/forklift.konveyor.io/v1beta1/plans")
	if err != nil {
		return nil, status, err
	}
	var l listType
	if err := json.Unmarshal(raw, &l); err != nil {
		return nil, status, fmt.Errorf("decode plans: %w", err)
	}
	plans := make([]planRef, 0, len(l.Items))
	for _, it := range l.Items {
		pr := planRef{
			Name:      nestedString(it, "metadata", "name"),
			Namespace: nestedString(it, "metadata", "namespace"),
		}
		vmsRaw, _ := nestedSlice(it, "spec", "vms")
		for _, v := range vmsRaw {
			if vm, ok := v.(map[string]any); ok {
				pr.VMs = append(pr.VMs, planVM{ID: nestedString(vm, "id"), Name: nestedString(vm, "name")})
			}
		}
		pr.Status = parsePlanStatus(it)
		plans = append(plans, pr)
	}
	return plans, status, nil
}

// parsePlanStatus extracts conditions + the embedded migration per-VM pipeline.
func parsePlanStatus(it map[string]any) *planStatus {
	st, ok := nested(it, "status").(map[string]any)
	if !ok {
		return nil
	}
	ps := &planStatus{
		Started:   nestedString(st, "migration", "started"),
		Completed: nestedString(st, "migration", "completed"),
	}
	if conds, ok := nestedSlice(st, "conditions"); ok {
		for _, c := range conds {
			cm, ok := c.(map[string]any)
			if !ok {
				continue
			}
			ps.Conditions = append(ps.Conditions, planCondition{
				Type:     nestedString(cm, "type"),
				Status:   nestedString(cm, "status"),
				Category: nestedString(cm, "category"),
				Message:  nestedString(cm, "message"),
			})
		}
	}
	if vms, ok := nestedSlice(st, "migration", "vms"); ok {
		for _, v := range vms {
			vm, ok := v.(map[string]any)
			if !ok {
				continue
			}
			vs := planVMStatus{
				ID:        nestedString(vm, "id"),
				Name:      nestedString(vm, "name"),
				Phase:     nestedString(vm, "phase"),
				Started:   nestedString(vm, "started"),
				Completed: nestedString(vm, "completed"),
			}
			if steps, ok := nestedSlice(vm, "pipeline"); ok {
				for _, s := range steps {
					sm, ok := s.(map[string]any)
					if !ok {
						continue
					}
					vs.Pipeline = append(vs.Pipeline, planStep{
						Name:      nestedString(sm, "name"),
						Phase:     nestedString(sm, "phase"),
						Completed: int64(nestedFloat(sm, "progress", "completed")),
						Total:     int64(nestedFloat(sm, "progress", "total")),
					})
				}
			}
			if reasons, ok := nestedSlice(vm, "error", "reasons"); ok {
				for _, r := range reasons {
					if s, ok := r.(string); ok {
						vs.Error = append(vs.Error, s)
					}
				}
			}
			ps.VMs = append(ps.VMs, vs)
		}
	}
	return ps
}
