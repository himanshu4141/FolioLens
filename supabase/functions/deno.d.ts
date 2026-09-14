/**
 * Minimal ambient declaration for the Deno globals actually referenced by
 * Edge Functions in this repo (Deno.serve, Deno.env.get). Real type-checking
 * for supabase/functions happens via the Deno CLI / editor Deno extension
 * outside this npm project — tsconfig.json excludes the directory entirely
 * (see CLAUDE.md's Edge Functions rules) — but ts-jest still type-checks
 * whatever it's asked to `require`, including an index.ts a handler-level
 * test imports directly, and needs something to resolve the bare `Deno`
 * identifier for that. Intentionally narrow: extend only if another Deno API
 * gets referenced by code a test needs to import.
 */
declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
  env: {
    get(key: string): string | undefined;
  };
};
