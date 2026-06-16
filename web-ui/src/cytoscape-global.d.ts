// Cytoscape.js is loaded as a vendored classic <script> (static/vendor/
// cytoscape.min.js), so it is a runtime global rather than an npm import. We
// type only the small surface the app uses; node data is strongly typed.
import type { GraphNodeData } from "./types.js";

export {};

declare global {
  function cytoscape(options?: Record<string, unknown>): CyCore;

  interface CyCore {
    destroy(): void;
    on(event: string, selectorOrHandler: string | ((evt: CyEvent) => void), handler?: (evt: CyEvent) => void): void;
    one(event: string, handler: () => void): void;
    $(selector: string): { unselect(): void };
    getElementById(id: string): CyNode;
    center(eles?: CyNode): void;
    zoom(): number;
    zoom(level: number): void;
  }

  interface CyNode {
    data(): GraphNodeData;
    id(): string;
    empty(): boolean;
    select(): void;
  }

  interface CyEvent {
    target: CyNode | CyCore;
  }
}
