# 🔨 AgenticForge — Meta-IDE & Scaffolder for the Open Agentic Web

> **Turn any static HTML page into an Open Agentic Website in seconds.** An AI-powered browser IDE that parses the DOM, computes mathematical actionability & risk scores, designs multi-agent `.network.json` topologies, and wires safe JS tools with automatic **Human-in-the-Loop (HITL)** guards.

Built for the **[Open Agentic Web Challenge](https://cognizant-agenticweb.devpost.com/)** following the **[cognizant-ai-labs/agentic-web](https://github.com/cognizant-ai-labs/agentic-web)** specification.

---

## ✨ Key Features

1. **🔍 Target DOM Inspector & Heuristic Risk Scorer:** Parses any HTML snippet via `DOMParser` and computes an **Actionability Score** $A(e_i)$ and a **Mutation Risk Score** $R(e_i)$ for every interactive control.
2. **🕸️ Multi-Agent Blueprinting (`.network.json`):** Synthesizes an `nsdeploy`-compliant multi-agent hierarchy (`FrontDesk_Coordinator`, `State_Form_Specialist`, and `Critical_Action_Specialist`).
3. **🛡️ Safety by Default (`site.js` + Auto-HITL):** Generates real-time DOM state grounding (`window.getPageState()`) and wraps any tool where $R(e_i) \ge \tau_{\text{HITL}}$ ($0.65$) in a mandatory **Human-in-the-Loop** browser confirmation modal.
4. **🧪 Live Sandbox Simulator:** Test the newly generated agent network directly against the live target DOM inside the browser before exporting the ready-to-deploy `.zip` bundle.
5. **🔑 Client-Side BYOK Router:** Pre-configured for **Mozilla Otari** (`alibaba/qwen-3.5-35b-a3b`) and OpenAI-compatible CORS endpoints with zero backend servers.

---

## 🚀 Quick Start (Local Run)

No build step or backend server required! Clone this repository and serve the directory with any static HTTP server:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

---

## 📂 Repository Structure

* `index.html` — Complete **AgenticForge Studio** 4-panel IDE (100% client-side HTML5/CSS3/ES6+).
* `devstudio_assistant.network.json` — AgenticForge's own 4-agent network specification (`Architect_Coordinator`, `DOM_Scanner_Agent`, `Topology_Builder_Agent`, `Wiring_Generator_Agent`).
* `target_assistant.network.json` — Sample generated multi-agent network specification for the Medical Clinic template.
* `site.js` — Sample generated state-grounding hooks (`getPageState()`) and Human-in-the-Loop tool wrappers.
