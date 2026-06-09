#!/bin/bash
# Copyright (c) 2026 Tigera, Inc. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# deploy-forklift-kind.sh — deploys Forklift and its prerequisites onto a
# KIND cluster that already has Calico and MockVirt installed.
#
# This script:
#   1. Installs prerequisites (Multus, vcsim, cert-manager, CDI, CNA, OLM)
#   2. (Optionally) builds and pushes Forklift images
#   3. Deploys Forklift via OLM
#   4. Creates the ForkliftController CR
#   5. Verifies the deployment
#
# Usage:
#   ./hack/deploy-forklift-kind.sh
#
# Prerequisites:
#   - A KIND cluster with Calico and MockVirt already deployed
#   - kubectl configured to talk to the cluster
#   - Docker logged into the target registry (for image push)
#
# Environment variables (all optional):
#   KUBECONFIG       Path to kubeconfig (default: $CALICO_REPO/hack/test/kind/kind-kubeconfig.yaml)
#   FORKLIFT_REPO    Path to forklift repo (default: ~/go/src/github.com/kubev2v/forklift)
#   REGISTRY         Image registry (default: docker.io)
#   REGISTRY_ORG     Image org/user (default: songtjiang)
#   REGISTRY_TAG     Image tag (default: dev)
#   PLATFORM         Target platform (default: linux/amd64)
#   NAMESPACE        Forklift namespace (default: konveyor-forklift)
#   BUILD_IMAGES     Set to "true" to build and push images (default: false)

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR=$(cd "$(dirname "$0")"; pwd)

# Try to find the calico repo root (parent of hack/).
CALICO_REPO="${SCRIPT_DIR}/.."

: "${FORKLIFT_REPO:=${HOME}/go/src/github.com/kubev2v/forklift}"
: "${KUBECONFIG:=${CALICO_REPO}/hack/test/kind/kind-kubeconfig.yaml}"
: "${REGISTRY:=docker.io}"
: "${REGISTRY_ORG:=songtjiang}"
: "${REGISTRY_TAG:=dev}"
: "${PLATFORM:=linux/amd64}"
: "${NAMESPACE:=konveyor-forklift}"
: "${BUILD_IMAGES:=false}"

export KUBECONFIG

MAKE_VARS="REGISTRY=${REGISTRY} REGISTRY_ORG=${REGISTRY_ORG} REGISTRY_TAG=${REGISTRY_TAG} PLATFORM=${PLATFORM}"

echo "=== Deploy Forklift on KIND ==="
echo "  Calico repo:   ${CALICO_REPO}"
echo "  Forklift repo: ${FORKLIFT_REPO}"
echo "  Kubeconfig:    ${KUBECONFIG}"
echo "  Registry:      ${REGISTRY}/${REGISTRY_ORG}"
echo "  Tag:           ${REGISTRY_TAG}"
echo "  Platform:      ${PLATFORM}"
echo "  Namespace:     ${NAMESPACE}"
echo "  Build images:  ${BUILD_IMAGES}"
echo

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------
wait_for_deployment() {
    local ns=$1 name=$2
    echo "  Waiting for ${ns}/${name} ..."
    kubectl wait --for=condition=Available --timeout=300s deployment -n "${ns}" "${name}"
}

wait_for_all_deployments() {
    local ns=$1
    echo "  Waiting for all deployments in ${ns} ..."
    kubectl wait --for=condition=Available --timeout=300s deployment -n "${ns}" --all
}

skip_if_exists() {
    local resource=$1 name=$2 ns=${3:-}
    local ns_flag=""
    if [ -n "${ns}" ]; then
        ns_flag="-n ${ns}"
    fi
    # shellcheck disable=SC2086
    if kubectl get "${resource}" ${ns_flag} "${name}" >/dev/null 2>&1; then
        return 0  # exists, skip
    fi
    return 1  # does not exist, install
}

# =========================================================================
# STEP 1: Install prerequisites
# =========================================================================
echo "============================================"
echo "Step 1: Install prerequisites"
echo "============================================"
echo

# --- Multus CNI (thin plugin) ---
echo "--- Multus CNI ---"
if skip_if_exists daemonset kube-multus-ds kube-system; then
    echo "  Already installed, skipping."
else
    kubectl apply -f https://raw.githubusercontent.com/k8snetworkplumbingwg/multus-cni/master/deployments/multus-daemonset.yml
    kubectl -n kube-system rollout status daemonset/kube-multus-ds --timeout=120s
    echo "  Installed."
fi
echo

# --- vcsim (VMware vCenter simulator) ---
echo "--- vcsim ---"
if skip_if_exists deployment vcsim default; then
    echo "  Already installed, skipping."
else
    kubectl apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vcsim
  namespace: default
spec:
  selector:
    matchLabels:
      app: vcsim
  template:
    metadata:
      labels:
        app: vcsim
    spec:
      containers:
        - name: vcsim
          image: vmware/vcsim:latest
          ports:
            - name: https
              containerPort: 8989
---
apiVersion: v1
kind: Service
metadata:
  name: vcsim
  namespace: default
spec:
  selector:
    app: vcsim
  ports:
    - port: 8989
      targetPort: 8989
EOF
    kubectl rollout status deployment/vcsim -n default --timeout=120s
    echo "  Installed (service: vcsim.default.svc:8989)."
fi
echo

# --- cert-manager ---
echo "--- cert-manager ---"
if kubectl get namespace cert-manager >/dev/null 2>&1; then
    echo "  Already installed, skipping."
else
    CERT_MANAGER_VERSION=$(curl -s https://api.github.com/repos/cert-manager/cert-manager/releases/latest | grep 'tag_name' | sed -E 's/.*"([^"]+)".*/\1/')
    echo "  Version: ${CERT_MANAGER_VERSION}"
    kubectl apply -f "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml"
    wait_for_all_deployments cert-manager
    echo "  Installed."
fi
echo

# --- CDI (Containerized Data Importer) ---
echo "--- CDI ---"
if kubectl get namespace cdi >/dev/null 2>&1; then
    echo "  Already installed, skipping."
else
    CDI_VERSION=$(curl -s https://api.github.com/repos/kubevirt/containerized-data-importer/releases/latest | grep 'tag_name' | sed -E 's/.*"([^"]+)".*/\1/')
    echo "  Version: ${CDI_VERSION}"
    kubectl create -f "https://github.com/kubevirt/containerized-data-importer/releases/download/${CDI_VERSION}/cdi-operator.yaml" --dry-run=client -o yaml | kubectl apply -f -
    kubectl create -f "https://github.com/kubevirt/containerized-data-importer/releases/download/${CDI_VERSION}/cdi-cr.yaml" --dry-run=client -o yaml | kubectl apply -f -
    wait_for_deployment cdi cdi-operator
    echo "  Installed."
fi
echo

# --- CNA (Cluster Network Addons) ---
echo "--- Cluster Network Addons ---"
if kubectl get namespace cluster-network-addons >/dev/null 2>&1; then
    echo "  Already installed, skipping."
else
    CNA_VERSION=$(curl -s https://api.github.com/repos/kubevirt/cluster-network-addons-operator/releases/latest | grep 'tag_name' | sed -E 's/.*"([^"]+)".*/\1/')
    echo "  Version: ${CNA_VERSION}"
    kubectl apply -f "https://github.com/kubevirt/cluster-network-addons-operator/releases/download/${CNA_VERSION}/namespace.yaml"
    kubectl apply -f "https://github.com/kubevirt/cluster-network-addons-operator/releases/download/${CNA_VERSION}/network-addons-config.crd.yaml"
    kubectl apply -f "https://github.com/kubevirt/cluster-network-addons-operator/releases/download/${CNA_VERSION}/operator.yaml"
    wait_for_deployment cluster-network-addons cluster-network-addons-operator
    cat <<'NACEOF' | kubectl apply -f -
apiVersion: networkaddonsoperator.network.kubevirt.io/v1
kind: NetworkAddonsConfig
metadata:
  name: cluster
  namespace: cluster-network-addons
spec:
  multus: {}
  linuxBridge: {}
  macvtap: {}
  imagePullPolicy: Always
NACEOF
    kubectl wait --for=condition=Available --timeout=300s networkaddonsconfig cluster
    echo "  Installed."
fi
echo

# --- OLM (Operator Lifecycle Manager) ---
echo "--- OLM ---"
if kubectl get namespace olm >/dev/null 2>&1; then
    echo "  Already installed, skipping."
else
    kubectl apply -f https://raw.githubusercontent.com/operator-framework/operator-lifecycle-manager/master/deploy/upstream/quickstart/crds.yaml
    kubectl apply -f https://raw.githubusercontent.com/operator-framework/operator-lifecycle-manager/master/deploy/upstream/quickstart/olm.yaml
    wait_for_deployment olm olm-operator
    wait_for_deployment olm catalog-operator
    echo "  Installed."
fi
echo

echo "Prerequisites complete."
echo

# =========================================================================
# STEP 2 & 3: Build and push Forklift images (optional)
# =========================================================================
# To build and push images, run this script with BUILD_IMAGES=true.
# This builds the 6 core component images needed for a cold vSphere
# migration, plus the OLM bundle and index images.
#
# Images built:
#   - forklift-controller        (migration orchestration)
#   - forklift-api               (REST API)
#   - forklift-validation        (OPA validation)
#   - forklift-operator          (Ansible operator)
#   - forklift-virt-v2v          (disk conversion)
#   - populator-controller       (volume populator)
#   - forklift-operator-bundle   (OLM bundle metadata)
#   - forklift-operator-index    (OLM catalog index)
#
# Images NOT built (unused for vSphere cold migration, defaults to upstream):
#   - ova-provider-server, ova-proxy, hyperv-provider-server,
#     ovirt-populator, openstack-populator, vsphere-copy-offload-populator,
#     forklift-cli-download, forklift-must-gather, forklift-console-plugin

if [ "${BUILD_IMAGES}" = "true" ]; then
    echo "============================================"
    echo "Step 2: Build Forklift images"
    echo "============================================"
    echo
    cd "${FORKLIFT_REPO}"

    COMPONENTS=(
        build-controller-image
        build-api-image
        build-validation-image
        build-operator-image
        build-virt-v2v-image
        build-populator-controller-image
    )
    for target in "${COMPONENTS[@]}"; do
        echo "--- ${target} ---"
        make "${target}" ${MAKE_VARS}
        echo
    done

    echo "============================================"
    echo "Step 3: Push Forklift images"
    echo "============================================"
    echo
    PUSH_COMPONENTS=(
        push-controller-image
        push-api-image
        push-validation-image
        push-operator-image
        push-virt-v2v-image
        push-populator-controller-image
    )
    for target in "${PUSH_COMPONENTS[@]}"; do
        echo "--- ${target} ---"
        make "${target}" ${MAKE_VARS}
        echo
    done

    echo "============================================"
    echo "Step 4: Build and push bundle + index"
    echo "============================================"
    echo
    make build-operator-bundle-image ${MAKE_VARS}
    make push-operator-bundle-image  ${MAKE_VARS}
    make build-operator-index-image  ${MAKE_VARS}
    make push-operator-index-image   ${MAKE_VARS}
    echo
    echo "All images built and pushed."
    echo
else
    echo "(Skipping image build — set BUILD_IMAGES=true to build and push.)"
    echo
fi

# =========================================================================
# STEP 5: Deploy Forklift via OLM
# =========================================================================
echo "============================================"
echo "Step 5: Deploy Forklift"
echo "============================================"
echo

cd "${FORKLIFT_REPO}"

# Create namespace if needed.
kubectl create namespace "${NAMESPACE}" 2>/dev/null || true

# Deploy OLM catalog source, operator group, and subscription.
echo "--- Deploying OLM resources ---"
make deploy-k8s ${MAKE_VARS}
echo

# Wait for catalog source to become ready.
echo "--- Waiting for CatalogSource ---"
kubectl wait --for=jsonpath='{.status.connectionState.lastObservedState}'=READY \
    catalogsource/konveyor-forklift -n "${NAMESPACE}" --timeout=120s
echo

# Wait for CSV to appear and succeed.
echo "--- Waiting for CSV ---"
for i in $(seq 1 60); do
    csv=$(kubectl get csv -n "${NAMESPACE}" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    if [ -n "${csv}" ]; then
        echo "  CSV found: ${csv}"
        break
    fi
    sleep 5
done
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded csv -n "${NAMESPACE}" --all --timeout=300s
echo

# Deploy ForkliftController CR.
echo "--- Deploying ForkliftController ---"
make deploy-k8s-controller NAMESPACE="${NAMESPACE}"
echo

# =========================================================================
# STEP 6: Verify deployment
# =========================================================================
echo "============================================"
echo "Step 6: Verify deployment"
echo "============================================"
echo

# Give pods time to start.
echo "Waiting 30s for pods to start..."
sleep 30

echo
echo "CSV status:"
kubectl get csv -n "${NAMESPACE}"
echo
echo "Pod status:"
kubectl get pods -n "${NAMESPACE}"
echo

# Check core deployments (ignore ova-proxy which uses an upstream image
# that may not exist with our custom tag).
CORE_DEPLOYMENTS=(
    forklift-controller
    forklift-api
    forklift-operator
    forklift-validation
    forklift-volume-populator-controller
)
FAILED=0
for dep in "${CORE_DEPLOYMENTS[@]}"; do
    if kubectl get deployment -n "${NAMESPACE}" "${dep}" >/dev/null 2>&1; then
        ready=$(kubectl get deployment -n "${NAMESPACE}" "${dep}" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
        if [ "${ready:-0}" -ge 1 ]; then
            echo "  [OK] ${dep}"
        else
            echo "  [PENDING] ${dep} (readyReplicas=${ready:-0})"
            FAILED=1
        fi
    else
        echo "  [MISSING] ${dep}"
        FAILED=1
    fi
done

echo
if [ "${FAILED}" -eq 0 ]; then
    echo "=== Forklift deployed successfully ==="
else
    echo "=== WARNING: Some deployments are not ready yet ==="
    echo "    Run 'kubectl get pods -n ${NAMESPACE}' to check status."
fi
echo
echo "vcsim endpoint: vcsim.default.svc:8989 (user:pass)"
echo "Forklift namespace: ${NAMESPACE}"
