// Language-neutral facts an extractor pulls from one source file.
// The indexer resolves them across files and writes them to the repo graph.

export type Lang = 'ts' | 'py';
export type Binding = 'literal' | 'dynamic';

export interface FnFact { name: string; line: number }   // name: qualified within file, e.g. "Billing.charge" or "<module>"
export interface CallFact { from: string; callee: string[]; line: number } // callee: ["charge"] | ["self","charge"] | ["billing","charge"]
export interface ImportFact { local: string; module: string; imported: string | '*' } // imported '*' = namespace/module import
export interface RouteFact { method: string; path: string; handler: string; line: number }

export interface ArgFact {
  name: string;
  binding: Binding;
  values: string[];          // literal values; >1 when iterated from a literal list (fallback chain)
}

export interface CallSiteFact {
  provider: string;
  resource: string[];        // e.g. ["chat","completions"]
  method: string;            // e.g. "create"
  fn: string;                // enclosing function name (FnFact.name)
  line: number;
  snippet: string;
  args: ArgFact[];
  fallbackDepth: number;     // >0 when inside an except/catch whose try block also calls a provider
}

/** A client binding a file exports (e.g. `export const stripe = new Stripe(...)`), so importers can use it. */
export interface ExportedClient { name: string; provider: string }

export interface FileFacts {
  path: string;              // repo-relative, posix
  lang: Lang;
  functions: FnFact[];
  calls: CallFact[];
  imports: ImportFact[];
  routes: RouteFact[];
  callSites: CallSiteFact[];
  exportedClients: ExportedClient[];
}

/** Client bindings imported from other repo files, resolved before extraction. */
export type ImportedClients = Map<string, string>; // local name -> provider id
