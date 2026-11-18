# 🔨 AgenticForge — Meta-IDE & Scaffolder for the Open Agentic Web (MVP Profile 0.2)

> **Turn any static HTML page into a conforming Open Agentic Website in seconds.** A 100% client-side, zero-backend Developer Studio that parses the DOM, computes Actionability $A(e_i)$ and Mutation Risk $R(e_i)$ scores, synthesizes **Cognizant Neuro SAN** `.network.json` + `agent-manifest.json` + `links.json` artifacts, and enforces user-owned **Human-in-the-Loop (HITL)** action receipts.

Built for the **Open Agentic Web Challenge** conforming to the **Minimum Viable Specification for a Worldwide Agentic Web (MVP Profile 0.2 — Cognizant AI Lab)**.

---

## ✅ 7/7 MVP Profile 0.2 Interoperability Checks Verified

1. **Two+ Agent HOCON & Manifest (Section 2 & 3.3):** Publishes `agent-manifest.json` and resolved Neuro SAN `.network.json` graphs (`front_man`, `metadata`, `tools[]`).
2. **Pluggable Inference & BYOK (Section 4):** Pre-configured for **Mozilla Otari** (`alibaba/qwen-3.5-35b-a3b` on `/api/v1`), OpenAI-compatible BYOK in origin-scoped `localStorage`, and a built-in zero-key deterministic engine.
3. **Grounded Local Site Actions (Section 1.2 & 3.1):** Registers DOM capabilities in `site.js` (`window.RegisteredSiteActions`) and `discovered-actions.json`.
4. **Peer Network Composition (Section 3.2):** Resolves symbolic peer links via `links.json` and requests explicit user approval via the **Peer Origin Consent** modal.
5. **Router-Only Disclosure (Section 4):** Caller's BYOK key is never transmitted to peer origins.
6. **Private Context Isolation (`sly_data` — Section 5):** Enforces `deny-by-default` across peer boundaries (`credit_card_token` and `auth_cookie` redacted).
7. **Fail-Closed & Bounded Execution (Section 3.1, 5 & 6):** Interactive drills verify clean halts on Malformed Networks, Composition Cycles, Over-Budget Calls (`> 8`), and Unapproved Origins.

---

## 🚀 Quick Local Run

```bash
python3 -m http.server 8080
# Open http://localhost:8080 in your browser
```
