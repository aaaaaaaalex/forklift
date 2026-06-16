// Shapes of the snapshot served by the Go backend at /api/inventory, plus the
// Cytoscape-compatible graph element model the frontend builds from it.

export interface Concern {
  id?: string;
  label?: string;
  category?: string;
  assessment?: string;
}

export interface Ref {
  kind?: string;
  id?: string;
}

export interface Nic {
  network?: Ref;
  mac?: string;
  order?: number;
  [key: string]: unknown;
}

export interface VM {
  id?: string;
  uid?: string;
  name?: string;
  namespace?: string;
  powerState?: string;
  nics?: Nic[];
  networks?: Ref[];
  concerns?: Concern[];
  [key: string]: unknown;
}

export interface VNetwork {
  id?: string;
  name?: string;
  variant?: string;
  vlanId?: string;
  [key: string]: unknown;
}

export interface Nad {
  uid?: string;
  namespace?: string;
  name?: string;
  object?: { spec?: { config?: string }; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ProviderResources {
  vms?: VM[];
  networks?: VNetwork[];
  networkattachmentdefinitions?: Nad[];
  [key: string]: unknown;
}

export interface Provider {
  type: string;
  name?: string;
  namespace?: string;
  uid: string;
  resources?: ProviderResources;
  counts?: Record<string, number>;
  [key: string]: unknown;
}

export interface CalicoVlan {
  vid: number;
  subnets?: string[];
  eligiblePools?: string[];
}

export interface CalicoNetwork {
  name: string;
  vlans?: CalicoVlan[];
  errors?: string[];
  [key: string]: unknown;
}

export interface CalicoIPPool {
  name: string;
  cidr?: string;
  [key: string]: unknown;
}

export interface CalicoData {
  networks?: CalicoNetwork[];
  ippools?: CalicoIPPool[];
  errors?: string[];
}

export interface PlanVM {
  id?: string;
  name?: string;
}

export interface PlanStep {
  name?: string;
  phase?: string;
  completed?: number;
  total?: number;
}

export interface PlanVMStatus {
  id?: string;
  name?: string;
  phase?: string;
  started?: string;
  completed?: string;
  pipeline?: PlanStep[];
  error?: string[];
}

export interface PlanCondition {
  type?: string;
  status?: string;
  category?: string;
  message?: string;
}

export interface PlanStatus {
  conditions?: PlanCondition[];
  started?: string;
  completed?: string;
  vms?: PlanVMStatus[];
}

export interface Plan {
  name: string;
  namespace?: string;
  vms?: PlanVM[];
  status?: PlanStatus;
}

export interface LiveMigration {
  namespace: string;
  name: string;
  vmiName: string;
  phase?: string;
  sourceNode?: string;
  sourcePod?: string;
  targetNode?: string;
  targetPod?: string;
  started?: string;
  ended?: string;
  completed?: boolean;
  failed?: boolean;
}

export interface VMIRef {
  namespace: string;
  name: string;
  phase?: string;
  node?: string;
  uid?: string;
}

export interface LauncherPod {
  namespace: string;
  name: string;
  vmName?: string;
  node?: string;
  phase?: string;
}

export interface Snapshot {
  fetchedAt?: string;
  durationMs?: number;
  inventoryUrl?: string;
  providers?: Provider[];
  calico?: CalicoData | null;
  plans?: Plan[];
  plansError?: string;
  liveMigrations?: LiveMigration[];
  vmis?: VMIRef[];
  launcherPods?: LauncherPod[];
  errors?: string[];
  ok?: boolean;
}

// ---- graph model (consumed by Cytoscape) ----

// An error correlated to a node is either a Forklift concern or a plain string.
export type ErrorItem = Concern | string;

export interface GraphNodeData {
  id: string;
  label?: string;
  ntype?: string;
  raw?: Record<string, unknown>;
  errors?: ErrorItem[];
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
}

export interface GraphElement {
  data: GraphNodeData | GraphEdgeData;
  classes?: string;
}
