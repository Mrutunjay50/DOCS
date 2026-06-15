# SlashifyTech — Architecture in Diagrams

Visual companion to [ARCHITECTURE.md](ARCHITECTURE.md). Every diagram is **Mermaid** — it renders in VS Code's Markdown preview (with the Mermaid extension) and on GitHub. Read top to bottom: from the 10,000-ft system map down to sequences, data, deployment, and the queue.

> Backend: **Node 20 + Express** gateway · **Django 5 + DRF + Celery** processing engine.
> Queue: **RabbitMQ** is the single job broker — every async task runs through it, both Node tools (merge, compress, edit, convert) and Django/Celery (OCR, translate, image→PDF). Redis is used only for cache/sessions/rate-limits.
> Security model: **JWT** auth throughout; files encrypted at rest via **S3 SSE-S3** + TLS in transit (no KMS envelope encryption). Django kept private by **security-group rules**, not a separate private subnet.

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
    DJ["⚙️ Django Engine<br/>OCR · Translate · Image→PDF<br/>— SG-restricted, not public —"]

    EXT1["💳 Razorpay"]
    EXT2["🔤 Google Vision / Textract<br/>Google / DeepL"]
    EXT3["✉️ Resend / SES · MSG91"]
    EXT5["🪣 S3 (SSE-S3) + CloudFront"]

    U1 -- "JWT access token" --> GW
    U2 -- "admin JWT · TOTP · IP-allow" --> GW
    GW -- "HMAC-signed<br/>service token" --> DJ
    GW <--> EXT1
    GW <--> EXT3
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
    class EXT1,EXT2,EXT3,EXT5 ext;
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
            m6[06 PDF Tools · RabbitMQ]
        end
        subgraph ADMB["/admin/* · hardened"]
            n1[07 AdminUser + TOTP]
            n2[08 People & Documents]
            n3[09 Billing Ops]
            n4[10 Platform Ops]
        end
        subgraph MID["middleware spine"]
            x1{{JWT auth + org ctx}}
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

    T1 -- "api-client · JWT" --> MID
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

## 3. Document lifecycle & privacy

Files are encrypted at rest by **S3 SSE-S3** (AES-256, S3-managed) and travel over TLS. Admins are restricted to metadata by **application + JWT scope policy**. Everything is deleted at 24h.

```mermaid
flowchart LR
    subgraph ingress["① UPLOAD"]
        direction TB
        i1[Client uploads<br/>over TLS] --> i2[Gateway validates<br/>JWT + tier]
        i2 --> i3[(S3 SSE-S3<br/>encrypted at rest)]
        i2 --> i5[(Job/JobRef:<br/>metadata + SHA-256)]
    end

    subgraph work["② PROCESS — worker"]
        direction TB
        w1[Fetch object from S3] --> w2[OCR / Translate<br/>in memory]
        w2 --> w3[Store result<br/>in S3 SSE-S3]
    end

    subgraph admin["③ ADMIN — metadata only"]
        direction TB
        ad1[Reads JobRef<br/>metadata + SHA-256]
        ad2[/Policy: no content access<br/>· no download path/]
    end

    subgraph kill["④ DELETE @ 24h"]
        direction TB
        k1[S3 lifecycle rule] --> k2[Celery-beat sweep] --> k3[Object + record removed]
    end

    ingress ==> work
    ingress -. "metadata only" .-> admin
    work ==> kill

    classDef ok fill:#DCFCE7,stroke:#16A34A,color:#14532D;
    classDef no fill:#FEE2E2,stroke:#DC2626,color:#7F1D1D;
    classDef neutral fill:#F1F5F9,stroke:#64748B,color:#1E293B;
    class w1,w2,w3 ok;
    class ad2 no;
    class i1,i2,i3,i5,k1,k2,k3,ad1 neutral;
```

| Concern | Mechanism |
|---|---|
| At rest | S3 SSE-S3 (AES-256, S3-managed keys); RDS + ElastiCache encryption on |
| In transit | TLS everywhere (ACM on the ALB; internal TLS to Django) |
| Admin content lockout | application policy + JWT scope — admins have **no download route**, metadata only |
| Retention | 24h S3 lifecycle + Celery-beat sweep |

---

## 4. Request lifecycle — a translation job, end to end

```mermaid
sequenceDiagram
    autonumber
    participant C as 🖥️ web-b2c
    participant N as 🚪 Express Gateway
    participant S as 🪣 S3 (SSE-S3)
    participant D as ⚙️ Django (DRF)
    participant Q as 🔁 Celery Worker

    C->>N: POST /api/tools/translate (file, lang pair)
    activate N
    N->>N: JWT auth middleware · tier policy check
    N->>S: store upload (encrypted at rest)
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
    Q->>S: fetch object → process in memory
    Q->>Q: OCR (if scan) → translate → Devanagari export
    Q->>S: store result
    Q->>N: completion webhook → refresh JobRef
    deactivate Q

    C->>N: GET /api/jobs/{id}/download
    N->>S: mint short-lived signed URL
    N-->>C: 302 → signed URL (client never reaches Django)

    Note over S: @ 24h — S3 lifecycle + Celery-beat sweep delete the object
```

---

## 5. Data model — the two databases

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
        string s3_key
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

## 6. AWS deployment topology

Compute runs on **EC2** (Auto Scaling Groups, one per service role). No dedicated private subnet tier — every instance runs in the same subnets behind the VPC, and **security groups** enforce that only `api-node` reaches Django and the data stores. Only the public-facing instances are attached to the ALB.

```mermaid
flowchart TB
    NET((🌐 Internet)) --> CF[CloudFront CDN<br/>static + signed downloads]
    CF --> ALB[Application Load Balancer<br/>ACM TLS · WAF]

    subgraph VPC["VPC · ≥2 AZs"]
        subgraph EDGE["🟢 ALB-fronted EC2 (ASG)"]
            ALB --> f1[EC2: web-b2c]
            ALB --> f2[EC2: web-admin]
            ALB --> f3[EC2: api-node · Express]
        end
        subgraph INT["🔒 SG-restricted EC2 (ASG, not on ALB)"]
            f3 --> w1[EC2: workers-node<br/>RabbitMQ consumers]
            f3 --> w2[EC2: api-django]
            w2 --> w3[EC2: celery-workers<br/>heavy image]
        end
        subgraph DATA["💾 DATA layer (SG-restricted)"]
            rds1[(RDS: node-db · encrypted)]
            rds2[(RDS: django-db · encrypted)]
            mq[(🐰 Amazon MQ · RabbitMQ<br/>single job broker)]
            ec[(ElastiCache Redis<br/>cache / sessions)]
            s3[(S3: uploads/results/exports<br/>SSE-S3 · 24h lifecycle)]
        end
    end

    f3 --> rds1
    f3 --> ec
    f3 --> mq
    w2 --> rds2
    w1 & w2 & w3 --> mq
    w3 --> s3
    f3 --> s3
    w3 -. "cloud OCR/translate APIs" .-> NET

    classDef pub fill:#DCFCE7,stroke:#16A34A,color:#14532D;
    classDef priv fill:#E0E7FF,stroke:#4338CA,color:#312E81;
    classDef data fill:#FEF9C3,stroke:#CA8A04,color:#713F12;
    classDef edge fill:#F1F5F9,stroke:#64748B,color:#1E293B;
    class f1,f2,f3 pub;
    class w1,w2,w3 priv;
    class rds1,rds2,ec,s3,mq data;
    class CF,ALB,NET edge;
```

---

## 7. One queue for everything — RabbitMQ

Every async task goes through **RabbitMQ**. The gateway publishes a job; the right worker pool consumes it. Node tools and Django/Celery share the same broker — nothing heavy runs inline in a request.

```mermaid
flowchart LR
    GW[🚪 Express Gateway<br/>publishes job] --> MQ{{🐰 RabbitMQ<br/>single broker}}

    MQ -- merge / compress / edit / convert --> NW[Node workers]
    MQ -- OCR / translate / image→PDF --> CW[Celery workers]

    NW --> S3[(🪣 S3)]
    CW --> S3
    NW --> DONE[update JobRef → notify]
    CW --> DONE

    MQ -. "scale consumers<br/>on queue depth" .-> AS{{autoscale ↑↓}}

    classDef gate fill:#4F46E5,stroke:#312E81,color:#fff;
    classDef mq fill:#FDE68A,stroke:#D97706,color:#78350F;
    classDef worker fill:#EDE9FE,stroke:#7C3AED,color:#4C1D95;
    classDef sig fill:#DCFCE7,stroke:#16A34A,color:#14532D;
    class GW gate;
    class MQ mq;
    class NW,CW worker;
    class AS sig;
    class S3,DONE worker;
```

---

*Rendering tip: in VS Code, install the **Markdown Preview Mermaid Support** extension, then open this file and press `Ctrl+Shift+V`. On GitHub these render automatically.*
