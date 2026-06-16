# Forklift inventory web-UI (flui).
#
#   make frontend      compile the TypeScript frontend (src/ -> static/*.js)
#   make build         build the frontend, then the UI binary into ./bin/flui
#   make test          run frontend (tsc/node) and backend (go) unit tests
#   make image         build the container image (frontend built inside Docker)
#   make push          build the image and push it to the registry
#   make deploy        apply the install manifests
#   make port-forward  forward the service to localhost:8080
#   make dev           run flui locally against the inventory tunnelled via the bastion
#   make dev-local     run flui against a LOCAL cluster (e.g. kind) via LOCAL_KUBECONFIG
#
# The frontend lives in src/*.ts and is compiled by tsc into static/app.js +
# static/graph.js (embedded by the Go binary via go:embed). Go commands target
# the explicit package "." rather than "./..." so they don't descend into
# node_modules (which contains unrelated vendored Go sources).

IMAGE     ?= docker.io/projectalexo/flui
TAG       ?= latest
IMG       := $(IMAGE):$(TAG)

BIN_DIR   := bin
BIN       := $(BIN_DIR)/flui

NAMESPACE ?= konveyor-forklift
MANIFESTS := manifests/manifests.yaml

CONTAINER_TOOL ?= docker
NPM            ?= npm

# Run flui locally against the inventory tunnelled to the local machine.
# The lab cluster is 2 hops away (laptop -> bastion -> cluster). These targets open an
# SSH -L tunnel that runs `kubectl port-forward` on the bastion, then point a locally-run
# flui at it. Override any var on the command line, e.g. `make dev INV_NAMESPACE=konveyor-forklift`.
BASTION           ?= ubuntu@bastion-wg
REMOTE_KUBECONFIG ?= /home/ubuntu/kubeconfig
INV_NAMESPACE     ?= openshift-mtv
INV_SVC           ?= forklift-inventory
INV_PORT          ?= 8443
SA                ?= forklift-controller
TOKEN_TTL         ?= 60m
LOCAL_INV_PORT    ?= 8443
LOCAL_UI_PORT     ?= 8080
# Calico Network/IPPool CRDs are read from the kube API (not the inventory svc).
# `kubectl proxy` runs on the bastion (auth via REMOTE_KUBECONFIG) and is
# tunnelled to the laptop; flui points KUBE_API at it. Without this, KUBE_API
# defaults to https://kubernetes.default.svc, unreachable from a laptop, so the
# destination graph shows every NAD's Calico Network as "not found".
KUBE_PROXY_PORT   ?= 8001
LOCAL_KUBE_PORT   ?= 8001

# `make dev-local`: point flui at a LOCAL cluster (e.g. kind) reachable directly
# via its kubeconfig — no bastion/SSH. Override LOCAL_KUBECONFIG/LOCAL_INV_NS for
# a different cluster or Forklift namespace.
LOCAL_KUBECONFIG  ?= /home/alex/Repositories/github.com/projectcalico/calico/hack/test/kind/kind-kubeconfig.yaml
LOCAL_INV_NS      ?= konveyor-forklift
LOCAL_SA          ?= forklift-controller

# kubectl invocation on the bastion, pinned to the remote kubeconfig.
REMOTE_KUBECTL := KUBECONFIG=$(REMOTE_KUBECONFIG) kubectl

.PHONY: all
all: build

# Install node deps when package manifests change (sentinel = node_modules dir).
node_modules: package.json package-lock.json
	$(NPM) ci
	@touch node_modules

## frontend: compile the TypeScript frontend into static/*.js.
.PHONY: frontend
frontend: node_modules
	$(NPM) run build

## frontend-test: typecheck, lint, format-check, and unit-test the frontend.
.PHONY: frontend-test
frontend-test: node_modules
	$(NPM) run typecheck
	$(NPM) run lint
	$(NPM) run format:check
	$(NPM) test

## build: compile the frontend, then the UI binary (frontend embedded via go:embed).
.PHONY: build
build: frontend
	mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o $(BIN) .
	@echo "built $(BIN)"

## test: run frontend and backend unit tests.
.PHONY: test
test: frontend-test
	go test .

## image: package the binary into a container image.
.PHONY: image
image:
	$(CONTAINER_TOOL) build -t $(IMG) .

## push: build the image and push it to the registry.
.PHONY: push
push: image
	$(CONTAINER_TOOL) push $(IMG)

## deploy: install into the cluster (current kube context).
.PHONY: deploy
deploy:
	kubectl apply -f $(MANIFESTS)

## undeploy: remove from the cluster.
.PHONY: undeploy
undeploy:
	kubectl delete -f $(MANIFESTS) --ignore-not-found

## port-forward: expose the service on http://localhost:8080
.PHONY: port-forward
port-forward:
	kubectl -n $(NAMESPACE) port-forward svc/forklift-inventory-ui 8080:8080

## tunnel: open the inventory + kube-API tunnels (laptop -> bastion). Blocks; run in its own terminal.
.PHONY: tunnel
tunnel:
	ssh -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
	    -L $(LOCAL_INV_PORT):localhost:$(INV_PORT) -L $(LOCAL_KUBE_PORT):localhost:$(KUBE_PROXY_PORT) $(BASTION) \
	    "$(REMOTE_KUBECTL) -n $(INV_NAMESPACE) port-forward --address 127.0.0.1 svc/$(INV_SVC) $(INV_PORT):$(INV_PORT) & \
	     $(REMOTE_KUBECTL) proxy --address=127.0.0.1 --port=$(KUBE_PROXY_PORT) & wait"

## token: mint a short-lived inventory Bearer token from the bastion (prints to stdout).
.PHONY: token
token:
	@ssh $(BASTION) '$(REMOTE_KUBECTL) create token $(SA) -n $(INV_NAMESPACE) --duration=$(TOKEN_TTL)'

## run-local: run flui against an already-open tunnel (pair with `make tunnel`). Mints its own token.
.PHONY: run-local
run-local: build
	INVENTORY_URL=https://localhost:$(LOCAL_INV_PORT) \
	KUBE_API=http://127.0.0.1:$(LOCAL_KUBE_PORT) \
	INSECURE_SKIP_VERIFY=true \
	LISTEN_ADDR=:$(LOCAL_UI_PORT) \
	TOKEN=$$(ssh $(BASTION) '$(REMOTE_KUBECTL) create token $(SA) -n $(INV_NAMESPACE) --duration=$(TOKEN_TTL)') \
	$(BIN)

## dev: one-shot Option 1 — open the tunnel, mint a token, run flui on http://localhost:LOCAL_UI_PORT.
.PHONY: dev
dev: build
	@bash -c 'set -e; \
	  echo ">> opening tunnels via $(BASTION) (inventory localhost:$(LOCAL_INV_PORT), kube API localhost:$(LOCAL_KUBE_PORT))"; \
	  ssh -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
	      -L $(LOCAL_INV_PORT):localhost:$(INV_PORT) -L $(LOCAL_KUBE_PORT):localhost:$(KUBE_PROXY_PORT) $(BASTION) \
	      "$(REMOTE_KUBECTL) -n $(INV_NAMESPACE) port-forward --address 127.0.0.1 svc/$(INV_SVC) $(INV_PORT):$(INV_PORT) & \
	       $(REMOTE_KUBECTL) proxy --address=127.0.0.1 --port=$(KUBE_PROXY_PORT) & wait" & \
	  TUNNEL_PID=$$!; \
	  trap "echo; echo \">> closing tunnels\"; kill $$TUNNEL_PID 2>/dev/null" EXIT INT TERM; \
	  echo ">> waiting for tunnels (inventory + kube API)"; \
	  for i in $$(seq 1 30); do \
	    (exec 3<>/dev/tcp/127.0.0.1/$(LOCAL_INV_PORT)) 2>/dev/null && (exec 4<>/dev/tcp/127.0.0.1/$(LOCAL_KUBE_PORT)) 2>/dev/null \
	      && { exec 3>&- 3<&- 4>&- 4<&-; break; }; sleep 1; done; \
	  echo ">> minting token ($(SA), ttl $(TOKEN_TTL))"; \
	  TOKEN=$$(ssh $(BASTION) "$(REMOTE_KUBECTL) create token $(SA) -n $(INV_NAMESPACE) --duration=$(TOKEN_TTL)"); \
	  echo ">> starting flui on http://localhost:$(LOCAL_UI_PORT)  (Ctrl-C to stop and tear down the tunnels)"; \
	  INVENTORY_URL=https://localhost:$(LOCAL_INV_PORT) KUBE_API=http://127.0.0.1:$(LOCAL_KUBE_PORT) INSECURE_SKIP_VERIFY=true LISTEN_ADDR=:$(LOCAL_UI_PORT) TOKEN=$$TOKEN $(BIN)'

## dev-local: run flui against a LOCAL cluster (e.g. kind) via LOCAL_KUBECONFIG — no SSH.
# `kubectl port-forward` / `kubectl proxy` drop their connection after a while
# and exit; each runs in an auto-restart loop so a dropped tunnel comes back
# within ~2s (flui recovers on its next poll) instead of dying permanently.
.PHONY: dev-local
dev-local: build
	@bash -c 'set -e; \
	  export KUBECONFIG=$(LOCAL_KUBECONFIG); \
	  echo ">> using kubeconfig $$KUBECONFIG (ns $(LOCAL_INV_NS))"; \
	  ( set +e; while true; do kubectl -n $(LOCAL_INV_NS) port-forward svc/$(INV_SVC) $(LOCAL_INV_PORT):$(INV_PORT) >>/tmp/flui-inv-pf.log 2>&1; echo "[$$(date +%T)] inventory port-forward exited; restarting" >>/tmp/flui-inv-pf.log; sleep 2; done ) & PF=$$!; \
	  ( set +e; while true; do kubectl proxy --address=127.0.0.1 --port=$(LOCAL_KUBE_PORT) >>/tmp/flui-proxy.log 2>&1; echo "[$$(date +%T)] kube proxy exited; restarting" >>/tmp/flui-proxy.log; sleep 2; done ) & PX=$$!; \
	  trap "echo; echo \">> stopping tunnels\"; kill $$PF $$PX 2>/dev/null; fuser -k $(LOCAL_INV_PORT)/tcp $(LOCAL_KUBE_PORT)/tcp 2>/dev/null; true" EXIT INT TERM; \
	  echo ">> waiting for inventory ($(LOCAL_INV_PORT)) + kube API ($(LOCAL_KUBE_PORT))"; \
	  for i in $$(seq 1 30); do \
	    (exec 3<>/dev/tcp/127.0.0.1/$(LOCAL_INV_PORT)) 2>/dev/null && (exec 4<>/dev/tcp/127.0.0.1/$(LOCAL_KUBE_PORT)) 2>/dev/null \
	      && { exec 3>&- 3<&- 4>&- 4<&-; break; }; sleep 1; done; \
	  echo ">> minting token ($(LOCAL_SA), ns $(LOCAL_INV_NS))"; \
	  TOKEN=$$(kubectl -n $(LOCAL_INV_NS) create token $(LOCAL_SA) --duration=$(TOKEN_TTL)); \
	  echo ">> tunnels auto-restart on drop; logs: /tmp/flui-inv-pf.log /tmp/flui-proxy.log"; \
	  echo ">> starting flui on http://localhost:$(LOCAL_UI_PORT)  (Ctrl-C to stop)"; \
	  INVENTORY_URL=https://localhost:$(LOCAL_INV_PORT) KUBE_API=http://127.0.0.1:$(LOCAL_KUBE_PORT) INSECURE_SKIP_VERIFY=true LISTEN_ADDR=:$(LOCAL_UI_PORT) TOKEN=$$TOKEN $(BIN)'

## clean: remove build artifacts (binary + tsc output; keeps node_modules).
.PHONY: clean
clean:
	rm -rf $(BIN_DIR)
	rm -f static/app.js static/graph.js static/types.js

## help: list targets.
.PHONY: help
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //'
