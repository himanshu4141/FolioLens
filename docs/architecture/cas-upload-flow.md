# CAS PDF Upload Flow

The "manual" CAS path — user picks a PDF in the wizard or settings and the import lands in the same `cas_import` audit row + `transaction` table the inbound (Resend) flow writes to. The two paths converge at `importCASData()`.

## Where things live

```mermaid
graph TB
  subgraph Client["Mobile / web client"]
    pdf_screen["app/onboarding/pdf.tsx<br/>──────────────<br/>• expo-document-picker<br/>• Custom-password override"]
    upload_util["src/utils/casPdfUpload.ts<br/>──────────────<br/>• supabase.auth.getSession()<br/>• POST PDF binary"]
  end

  subgraph SupabaseEdge["Supabase Edge Functions"]
    parse_edge["parse-cas-pdf<br/>──────────────<br/>• Verifies user JWT<br/>• Reads pan + dob<br/>• Computes CDSL password<br/>• Forwards to Vercel parser<br/>• Calls importCASData()"]
    shared["_shared/import-cas.ts<br/>──────────────<br/>importCASData()<br/>(shared with cas-webhook-resend)"]
  end

  subgraph Vercel["Vercel (Python)"]
    parser["api/parse-cas-pdf.py<br/>──────────────<br/>• Verifies x-parser-secret<br/>• Detects CDSL/NSDL vs CAMS"]
    cdsl["api/_cdsl_nsdl_parser.py<br/>──────────────<br/>• pdfplumber + AMFI ISIN map"]
    casparser["api/_cas_parser.py<br/>──────────────<br/>• casparser library<br/>(CAMS / KFintech / MFCentral)"]
  end

  subgraph SupabaseDb["Supabase Postgres"]
    db["fund<br/>transaction<br/>user_fund<br/>cas_import"]
  end

  pdf_screen --> upload_util
  upload_util -- "POST + Bearer JWT" --> parse_edge
  parse_edge -- "POST + x-parser-secret" --> parser
  parser -- "if CDSL/NSDL" --> cdsl
  parser -- "if CAMS family" --> casparser
  cdsl -- "fetch ISIN map" --> amfi[("amfiindia.com<br/>NAVAll.txt")]
  parser -- "parsed JSON" --> parse_edge
  parse_edge --> shared
  shared --> db
```

## Sequence

```mermaid
sequenceDiagram
  participant U as User
  participant App as Mobile / web client
  participant SB as Supabase parse-cas-pdf<br/>(edge function)
  participant V as Vercel parser<br/>(/api/parse-cas-pdf)
  participant Lib as casparser / cdsl-nsdl<br/>(Python libs)
  participant DB as Supabase Postgres

  U->>App: tap "Choose PDF"
  App->>App: expo-document-picker.getDocumentAsync({type: 'application/pdf'})
  App->>App: read user_profile.pan + user_profile.dob<br/>(or custom password override)
  App->>App: supabase.auth.getSession() to get JWT
  App->>SB: POST /functions/v1/parse-cas-pdf<br/>Authorization Bearer JWT<br/>x-file-name, optional x-password-override<br/>body: PDF bytes

  SB->>SB: getUserFromRequest()<br/>(verify JWT)
  SB->>DB: SELECT pan, dob FROM user_profile
  DB-->>SB: pan, dob
  SB->>SB: derive CDSL password = PAN + DDMMYYYY
  SB->>V: POST /api/parse-cas-pdf<br/>x-parser-secret CAS_PARSER_SHARED_SECRET<br/>x-password (PAN), x-password-cdsl (PAN+DOB)<br/>body: PDF bytes

  V->>V: verify shared secret
  V->>V: pdfplumber peek first 3 pages
  alt PDF says CDSL or NSDL
    V->>Lib: parse_cdsl_nsdl(bytes, password)
    Lib->>Lib: pdfplumber extract<br/>+ AMFI ISIN enrichment
    Lib-->>V: schemes + transactions
  else CAMS / KFintech / MFCentral
    V->>Lib: casparser.read_cas_pdf(bytes, password)
    Lib-->>V: schemes + transactions
  end
  V-->>SB: { mutual_funds, transactions } JSON

  SB->>SB: countParsedTransactions()
  alt zero transactions
    SB->>DB: INSERT cas_import(status='failed',<br/>error_message='Detailed CAS required...')
    SB-->>App: error response
  else has transactions
    SB->>DB: importCASData()<br/>upsert fund, transaction, user_fund
    SB->>DB: INSERT cas_import(status='success', counts)
    DB-->>SB: import_id
    SB-->>App: { funds: N, transactions: M }
  end

  App->>U: "Import complete: N funds, M transactions"
```

## Why two parser families

| Issuer | Library | Password format | Notes |
|---|---|---|---|
| CAMS, KFintech, MFCentral | `casparser` (Python lib by codereverser) | PAN | Mature, handles AMC-issued summary + Detailed CAS variants |
| CDSL / NSDL | In-house `_cdsl_nsdl_parser.py` | PAN + DDMMYYYY | Demat statements; `casparser` doesn't handle these reliably |

`api/parse-cas-pdf.py` peeks at the first 3 pages and dispatches based on which format markers it finds. Both branches return the same normalized `{ mutual_funds, transactions }` shape so the caller doesn't care which parser ran.

## How this differs from the inbound (Resend) flow

| Aspect | Upload flow | Inbound flow ([cas-inbound-flow.md](./cas-inbound-flow.md)) |
|---|---|---|
| Triggered by | User tap | CAMS/KFintech monthly email forwarded to inbox token |
| Auth boundary | User JWT (`getUserFromRequest`) | FolioLens HMAC (`FOLIOLENS_INBOUND_ROUTER_SECRET`) |
| User identity | From session | From `user_profile.cas_inbox_token` lookup |
| PDF source | Direct upload bytes in request body | Resend presigned `download_url` |
| Parser path | Same `/api/parse-cas-pdf` | Same |
| Import helper | Same `importCASData()` | Same |
| Notification email | None — UI shows result inline | Yes — via `/api/cas-import-notify` |
| Background processor | Not needed (sync, fast enough) | Yes (`EdgeRuntime.waitUntil`) — Resend has 15s Svix timeout |

The two paths converge at `supabase/functions/_shared/import-cas.ts:importCASData()`. Anything that affects schema mapping or transaction shaping happens once and benefits both paths.
