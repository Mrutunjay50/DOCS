# SlashifyTech — Architecture in Diagrams

Visual companion to [ARCHITECTURE.md](ARCHITECTURE.md). Every diagram is **Mermaid** — it renders in VS Code's Markdown preview (with the Mermaid extension) and on GitHub. Read top to bottom: from the 10,000-ft system map down to sequences, data, and the build timeline.

> Backend: **Node 20 + Express** gateway · **Django 5 + DRF + Celery** processing engine.

---

## 1. System context — who talks to what

The single most important rule lives here: the browser only ever reaches Express, and only Express reaches Django.

```mermaid
flowchart TB
    subgraph users[" "]
        direction LR
        U1(["👤 Consumer<br/>web-b2c"])
        U2(["🛡️ Staff<br/>web-admin"])
    end

    GW{{"🚪 Express Gateway<br/>api-node<br/>— the ONLY public API —"}}
    DJ["⚙️ Django Engine<br/>OCR · Translate · Image→PDF<br/>— private, never public —"]

    EXT1["💳 Razorpay"]
    EXT2["🔤 Google Vision / Textract<br/>Google / DeepL"]
    EXT3["✉️ Resend / SES · MSG91"]
    EXT4["🔐 AWS KMS"]
    EXT5["🪣 S3 + CloudFront"]

    U1 -- "access token" --> GW
    U2 -- "admin token · TOTP · IP-allow" --> GW
    GW -- "HMAC-signed<br/>service token" --> DJ
    GW <--> EXT1
    GW <--> EXT3
    GW -- "GenerateDataKey (encrypt)" --> EXT4
    DJ -- "Decrypt (worker only)" --> EXT4
    DJ <--> EXT2
    GW <--> EXT5
    DJ <--> EXT5

    classDef client fill:#EEF2FF,stroke:#4F46E5,stroke-width:2px,color:#312E81;
    classDef gateway fill:#4F46E5,stroke:#312E81,stroke-width:2px,color:#fff;
    classDef engine fill:#7C3AED,stroke:#4C1D95,stroke-width:2px,color:#fff;
    classDef ext fill:#F8FAFC,stroke:#94A3B8,stroke-dasharray:4 3,color:#334155;
    class U1,U2 client;
    class GW gateway;
    class DJ engine;
    class EXT1,EXT2,EXT3,EXT4,EXT5 ext;
```

---

## 2. The three tiers, exploded

Every module, grouped by the tier and process that owns it.

```mermaid
flowchart TB
    subgraph T1["🖥️ TIER 1 · CLIENTS — Next.js App Router · TypeScript"]
        direction LR
        subgraph B2C["apps/web-b2c · mobile-first"]
            b1[Landing / Tools]
            b2[Translate + Camera Scan]
            b3[PDF.js Editor]
            b4[Dashboard / History]
            b5[Billing / Teams / Auth]
        end
        subgraph ADM["apps/web-admin · desktop-first"]
            a1[Users + 360 + Impersonate]
            a2[Payments / Invoices]
            a3[Document Oversight]
            a4[Support Desk]
            a5[Plans Editor / Analytics]
        end
        subgraph PKG["shared packages"]
            p1[(ui · shadcn)]
            p2[(types · OpenAPI-gen)]
            p3[(api-client)]
        end
    end

    subgraph T2["🚪 TIER 2 · GATEWAY — Node 20 · Express · Prisma"]
        direction LR
        subgraph PUB["public modules"]
            m1[01 Auth & Sessions]
            m2[02 Account]
            m3[03 Teams]
            m4[04 Billing + GST]
            m5[05 Orchestration]
            m6[06 PDF Tools · BullMQ]
        end
        subgraph ADMB["/admin/* · hardened"]
            n1[07 AdminUser + TOTP]
            n2[08 People & Documents]
            n3[09 Billing Ops]
            n4[10 Platform Ops]
        end
        subgraph MID["middleware spine"]
            x1{{auth + org ctx}}
            x2{{tier policy}}
            x3{{rate limit}}
            x4{{error envelope}}
        end
    end

    subgraph T3["⚙️ TIER 3 · PROCESSING — Django 5 · DRF · Celery"]
        direction LR
        d1[01 OCR · Tesseract<br/>+ pre-processing]
        d2[02 Translation<br/>+ Devanagari export]
        d3[03 Image → PDF]
        d4{{service-token auth}}
    end

    T1 -- "api-client · token" --> MID
    PUB --> m5
    m5 -- "ProcessingClient<br/>HMAC + X-User-Tier" --> d4
    m6 -. "scanned PDF→DOC<br/>fallback only" .-> d4
    ADMB -- "takedown bridge" --> d4

    classDef t1 fill:#EEF2FF,stroke:#4F46E5,color:#312E81;
    classDef t2 fill:#EDE9FE,stroke:#7C3AED,color:#4C1D95;
    classDef t3 fill:#F5F3FF,stroke:#8B5CF6,color:#4C1D95;
    class b1,b2,b3,b4,b5,a1,a2,a3,a4,a5,p1,p2,p3 t1;
    class m1,m2,m3,m4,m5,m6,n1,n2,n3,n4,x1,x2,x3,x4 t2;
    class d1,d2,d3,d4 t3;
```

---

## 3. The privacy boundary — KMS envelope encryption

Why "staff cannot read your documents" is true: it's IAM, not a checkbox in code. Note the three lanes can each touch KMS — but only the worker holds `Decrypt`.

```mermaid
flowchart LR
    subgraph ingress["① UPLOAD — api-node-role"]
        direction TB
        i1[Client uploads<br/>over TLS] --> i2[KMS<br/>GenerateDataKey]
        i2 --> i3[Encrypt file<br/>with data key]
        i3 --> i4[(S3: ciphertext)]
        i2 --> i5[(Job: encrypted<br/>data key + SHA-256)]
    end

    subgraph work["② PROCESS — worker-role 🔓"]
        direction TB
        w1[KMS Decrypt<br/>the data key] --> w2[Decrypt file<br/>in memory]
        w2 --> w3[OCR / Translate]
        w3 --> w4[Re-encrypt result<br/>· discard plaintext]
    end

    subgraph admin["③ ADMIN — admin-role 🚫"]
        direction TB
        ad1[Reads JobRef<br/>metadata + SHA-256]
        ad2[/NO kms:Decrypt<br/>cannot read content/]
    end

    subgraph kill["④ DELETE @ 24h"]
        direction TB
        k1[Delete data key<br/>= crypto-shred] --> k2[Ciphertext now<br/>unrecoverable] --> k3[Delete S3 object]
    end

    ingress ==> work
    ingress -. "metadata only" .-> admin
    work ==> kill

    classDef ok fill:#DCFCE7,stroke:#16A34A,color:#14532D;
    classDef no fill:#FEE2E2,stroke:#DC2626,color:#7F1D1D;
    classDef neutral fill:#F1F5F9,stroke:#64748B,color:#1E293B;
    class w1,w2,w3,w4 ok;
    class ad2 no;
    class i1,i2,i3,i4,i5,k1,k2,k3,ad1 neutral;
```

| Role | `GenerateDataKey` | `Decrypt` |
|---|:---:|:---:|
| `worker-role` (celery + workers-node) | ✅ | ✅ |
| `api-node-role` | ✅ | ❌ |
| `admin` paths | ❌ | ❌ |

---

## 4. Request lifecycle — a translation job, end to end

```mermaid
sequenceDiagram
    autonumber
    participant C as 🖥️ web-b2c
    participant N as 🚪 Express Gateway
    participant K as 🔐 KMS
    participant S as 🪣 S3
    participant D as ⚙️ Django (DRF)
    participant Q as 🔁 Celery Worker

    C->>N: POST /api/tools/translate (file, lang pair)
    activate N
    N->>N: auth middleware · tier policy check
    N->>K: GenerateDataKey
    K-->>N: plaintext + encrypted key
    N->>S: store ciphertext
    N->>D: ProcessingClient (HMAC-signed) /api/v1/translate/
    activate D
    D->>D: verify service token
    D->>Q: enqueue Celery task
    D-->>N: { job_id, status: queued }
    deactivate D
    N->>N: persist JobRef (mirrors job_id)
    N-->>C: { data: { jobId } }
    deactivate N

    Note over C,N: client now polls (SSE-swappable)
    loop until terminal
        C->>N: GET /api/jobs/{id}
        N-->>C: { status: processing | done }
    end

    activate Q
    Q->>K: Decrypt data key (only role that can)
    Q->>S: fetch ciphertext → decrypt in memory
    Q->>Q: OCR (if scan) → translate → Devanagari export
    Q->>S: store re-encrypted result
    Q->>N: completion webhook → refresh JobRef
    deactivate Q

    C->>N: GET /api/jobs/{id}/download
    N->>S: mint short-lived signed URL
    N-->>C: 302 → signed URL (client never reaches Django)

    Note over S: @ 24h — Celery-beat + S3 lifecycle crypto-shred
```

---

## 5. Trust boundaries — what each token can do

```mermaid
flowchart TB
    subgraph z1["🌐 PUBLIC ZONE"]
        c1[web-b2c]
        c2[web-admin]
    end
    subgraph z2["🚪 GATEWAY ZONE — public subnet"]
        g1[api-node<br/>Express]
    end
    subgraph z3["🔒 PRIVATE ZONE — private subnet"]
        p1[api-django]
        p2[celery-workers]
        p3[workers-node]
        db1[(node-db SoR)]
        db2[(django-db)]
        rd[(Redis)]
    end

    c1 -- "user JWT<br/>aud: user" --> g1
    c2 -- "admin JWT<br/>aud: admin + TOTP + IP-allow" --> g1
    g1 -- "HMAC + short-TTL<br/>+ X-User-Id/Tier" --> p1
    g1 --> db1
    g1 --> rd
    p1 --> db2
    p2 --> db2
    p1 --> rd
    p2 --> rd
    p3 --> rd

    note1["❌ user token never valid on /admin/*<br/>❌ admin token never valid on B2C<br/>❌ nothing but api-node can reach Django<br/>✅ ownership check on every resource (no IDOR)"]
    g1 -.- note1

    classDef pub fill:#FEF3C7,stroke:#D97706,color:#78350F;
    classDef gate fill:#4F46E5,stroke:#312E81,color:#fff;
    classDef priv fill:#E0E7FF,stroke:#4338CA,color:#312E81;
    classDef warn fill:#FEE2E2,stroke:#DC2626,color:#7F1D1D;
    class c1,c2 pub;
    class g1 gate;
    class p1,p2,p3,db1,db2,rd priv;
    class note1 warn;
```

---

## 6. Data model — the two databases

```mermaid
erDiagram
    USER ||--o{ SESSION : has
    USER ||--o{ OAUTHACCOUNT : links
    USER ||--o{ MEMBERSHIP : joins
    USER ||--o{ JOBREF : owns
    USER ||--o{ NOTIFICATION : receives
    USER ||--o{ SUPPORTTICKET : raises
    ORGANIZATION ||--o{ MEMBERSHIP : contains
    ORGANIZATION ||--o{ INVITE : issues
    ORGANIZATION ||--o| SUBSCRIPTION : "may own (pooled)"
    USER ||--o| SUBSCRIPTION : "may own (individual)"
    PLAN ||--o{ SUBSCRIPTION : priced_by
    SUBSCRIPTION ||--o{ INVOICE : bills
    JOBREF ||--|| JOB : "mirrors (cross-DB)"
    JOB ||--o{ UPLOADEDFILE : has
    JOB ||--o| OCRRESULT : produces
    JOB ||--o| TRANSLATIONRESULT : produces
    JOB ||--o{ USAGEEVENT : emits

    USER {
        uuid id PK
        string email
        string passwordHash "argon2id"
        enum status
    }
    ORGANIZATION {
        uuid id PK
        uuid ownerId FK
        int seatLimit
    }
    PLAN {
        uuid id PK
        int version
        int translationsPerMonth
        int storageGb
        int maxFileSizeMb
        json featureToggles
        string currency
    }
    JOBREF {
        uuid id PK
        string tool
        string sha256
        enum status
    }
    JOB {
        uuid id PK
        string user_id "from Node"
        string tier
        string sha256
        blob encrypted_data_key
        datetime expires_at
    }
    INVOICE {
        uuid id PK
        string gstin
        decimal cgst
        decimal sgst
        decimal igst
        string hsnSac
    }
```

> Solid relationship between **JOBREF** and **JOB** is logical, not a DB foreign key — they live in separate Postgres instances. `JobRef` (Node) caches status so history renders without re-querying Django.

---

## 7. AWS deployment topology

```mermaid
flowchart TB
    NET((🌐 Internet)) --> CF[CloudFront CDN<br/>static + signed downloads]
    CF --> ALB[Application Load Balancer<br/>ACM TLS · WAF]

    subgraph VPC["VPC · ≥2 AZs"]
        subgraph PUBSUB["🟢 PUBLIC subnets"]
            ALB --> f1[ECS: web-b2c]
            ALB --> f2[ECS: web-admin]
            ALB --> f3[ECS: api-node · Express]
        end
        subgraph PRIVSUB["🔒 PRIVATE subnets"]
            f3 --> w1[ECS: workers-node<br/>BullMQ]
            f3 --> w2[ECS: api-django]
            w2 --> w3[ECS: celery-workers<br/>heavy image]
        end
        subgraph DATA["💾 DATA layer"]
            rds1[(RDS: node-db)]
            rds2[(RDS: django-db)]
            ec[(ElastiCache Redis<br/>cluster)]
            s3[(S3: uploads/results/exports<br/>SSE-KMS · 24h lifecycle)]
            kms[(AWS KMS<br/>CMK + per-file keys)]
        end
        NAT[NAT Gateway<br/>worker egress]
    end

    f3 --> rds1
    f3 --> ec
    w2 --> rds2
    w1 & w2 & w3 --> ec
    w3 --> s3
    w3 --> kms
    f3 --> s3
    w3 -. "cloud OCR/translate APIs" .-> NAT

    classDef pub fill:#DCFCE7,stroke:#16A34A,color:#14532D;
    classDef priv fill:#E0E7FF,stroke:#4338CA,color:#312E81;
    classDef data fill:#FEF9C3,stroke:#CA8A04,color:#713F12;
    classDef edge fill:#F1F5F9,stroke:#64748B,color:#1E293B;
    class f1,f2,f3 pub;
    class w1,w2,w3 priv;
    class rds1,rds2,ec,s3,kms data;
    class CF,ALB,NAT,NET edge;
```

---

## 8. Worker queues & autoscaling signal

```mermaid
flowchart LR
    J([incoming job]) --> R{tier?}
    R -- premium --> PQ[[priority queue]]
    R -- free --> DQ[[default queue]]

    PQ & DQ --> SPLIT{tool type}
    SPLIT -- OCR/translate --> QA[(ocr-translate queue<br/>scales on depth)]
    SPLIT -- merge/compress/edit --> QB[(pdf-tools queue · BullMQ)]
    SPLIT -- LibreOffice/Ghostscript --> QC[(heavy queue<br/>LOW concurrency cap)]

    QA --> AS{{autoscale ↑↓<br/>on queue depth}}
    QB --> AS
    QC --> AS

    classDef q fill:#EDE9FE,stroke:#7C3AED,color:#4C1D95;
    classDef sig fill:#DCFCE7,stroke:#16A34A,color:#14532D;
    class QA,QB,QC,PQ,DQ q;
    class AS sig;
```

---

## 9. Build sequencing — the dependency timeline

The free-tier product works end to end after Step 2–3; everything after layers on without touching the processing path.

```mermaid
gantt
    title SlashifyTech build order (dependency-ordered)
    dateFormat X
    axisFormat %s

    section Foundations
    Step 0 · monorepo, CI/CD, KMS+IAM, bridge, auth, BullMQ/Celery   :done, s0, 0, 2

    section Free-tier core
    Step 1 · auth, OCR + pre-processing, B2C dashboard              :active, s1, 2, 3
    Step 2 · PDF suite + image→PDF + editor/camera                 :s2, 5, 3
    Step 3 · Money — plans, Razorpay, GST, account settings        :s3, 8, 2

    section Expansion
    Step 4 · Teams — orgs, seats, invites, pooled billing          :s4, 10, 2
    Step 5 · Premium engines (Vision/Textract, Google/DeepL)       :s5, 12, 1

    section Staff plane
    Step 6 · Admin backend + second frontend (dashboard last)      :s6, 13, 3

    section Launch
    Step 7 · Hardening, E2E, load, DPDP, pen test → GA             :crit, s7, 16, 2
```

```mermaid
flowchart LR
    S0([0 · Foundations]) --> S1([1 · Free core])
    S1 --> S2([2 · PDF suite])
    S2 --> S3([3 · Money])
    S3 --> S4([4 · Teams])
    S3 -.-> S5([5 · Premium])
    S4 --> S6([6 · Admin])
    S5 --> S6
    S6 --> S7([7 · Hardening → GA])

    S2 -. "🎉 free-tier product<br/>works end to end" .-> MILE{{MVP}}

    classDef step fill:#4F46E5,stroke:#312E81,color:#fff;
    classDef mile fill:#16A34A,stroke:#14532D,color:#fff;
    class S0,S1,S2,S3,S4,S5,S6,S7 step;
    class MILE mile;
```

---

## 10. Role ownership map (who builds what)

```mermaid
flowchart TB
    subgraph FE["🎨 Frontend dev — critical path (2 apps, sequenced)"]
        fe1[B2C · Steps 1–4]
        fe2[Admin · Step 6 on template]
    end
    subgraph ND["🟩 Node dev — 2nd heaviest"]
        nd1[gateway + auth + orchestration]
        nd2[teams + billing]
        nd3[entire admin backend]
    end
    subgraph DJ["🟪 Django dev — idle in 3–5 → lent to Node"]
        dj1[OCR + translation + image→PDF]
        dj2[premium adapters]
    end
    subgraph DO["🟦 DevOps — leads foundations, then floats"]
        do1[infra + KMS + CI/CD + images]
        do2[E2E/load harness + admin CRUD assist]
    end

    DJ -. "spare capacity Steps 3–5" .-> ND
    DO -. "absorb admin CRUD Step 6" .-> FE
    CONTRACT{{📜 OpenAPI contract<br/>= the only coordination tool<br/>no PM, no QA}}
    FE --- CONTRACT
    ND --- CONTRACT
    DJ --- CONTRACT
    DO --- CONTRACT

    classDef fe fill:#EEF2FF,stroke:#4F46E5,color:#312E81;
    classDef nd fill:#DCFCE7,stroke:#16A34A,color:#14532D;
    classDef dj fill:#EDE9FE,stroke:#7C3AED,color:#4C1D95;
    classDef do fill:#DBEAFE,stroke:#2563EB,color:#1E3A8A;
    classDef con fill:#FEF9C3,stroke:#CA8A04,color:#713F12;
    class fe1,fe2 fe;
    class nd1,nd2,nd3 nd;
    class dj1,dj2 dj;
    class do1,do2 do;
    class CONTRACT con;
```

---

*Rendering tip: in VS Code, install the **Markdown Preview Mermaid Support** extension, then open this file and press `Ctrl+Shift+V`. On GitHub these render automatically.*
