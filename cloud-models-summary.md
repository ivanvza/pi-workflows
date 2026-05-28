# ☁️ Cloud Model Overview

A comprehensive summary of 20 cloud-hosted AI models, ranked by community adoption.

> **Note:** All models listed are cloud-hosted (`☁️ Cloud`) and support tool use (`🛠 Tools`).

---

## 📊 Model Comparison Table

| Model | Description | Capabilities | Context | Pulls |
|---|---|---|---|---|
| **qwen3.5** | Open-source multimodal family delivering exceptional utility and performance | 🧠 👁 | 256K | 12.4M |
| **gemma4** | Frontier-level performance at each size; reasoning, agentic workflows, coding & multimodal | 🧠 👁 🎧 | 128K | 10.3M |
| **nemotron-3-super** | 120B open MoE (12B activated) for maximum compute efficiency in multi-agent apps | 🧠 | 256K | 2.4M |
| **glm-5** | 744B total / 40B active; built for complex systems engineering & long-horizon tasks | 🧠 | ~203K | 2.3M |
| **deepseek-v3.2** | Harmonizes high computational efficiency with superior reasoning & agent performance | 🧠 | 160K | 2.2M |
| **glm-5.1** | Next-gen flagship for agentic engineering; SOTA on SWE-Bench Pro | 🧠 | 198K | 2.2M |
| **minimax-m2.7** | M2-series for coding, agentic workflows & professional productivity | 🧠 | 200K | 2.2M |
| **minimax-m2.5** | SOTA LLM designed for real-world productivity & coding tasks | 🧠 | 198K | 2.2M |
| **glm-4.7** | Advancing coding capability | 🧠 | 198K | 2.2M |
| **gemini-3-flash-preview** | Frontier intelligence built for speed at a fraction of the cost | 🧠 👁 | 1M | 2.2M |
| **minimax-m2.1** | Exceptional multilingual capabilities for code engineering | — | 200K | 2.1M |
| **qwen3-coder-next** | Coding-focused model optimized for agentic workflows & local development | — | 256K | 1.3M |
| **devstral-small-2** | 24B model excelling at tool-driven codebase exploration & multi-file editing | 👁 | 384K | 840K |
| **rnj-1** | 8B dense model from Essential AI, optimized for code & STEM | — | 32K | 467K |
| **nemotron-3-nano** | 4B parameter efficient open model for intelligent agentic tasks | 🧠 | 1M | 455K |
| **kimi-k2.5** | Native multimodal agentic model with instant & thinking modes | 🧠 👁 | 256K | 296K |
| **kimi-k2.6** | Multimodal agentic model for long-horizon coding, proactive execution & swarm orchestration | 🧠 👁 | 256K | 262K |
| **devstral-2** | 123B model excelling at tool-driven codebase exploration & multi-file editing | — | 256K | 224K |
| **deepseek-v4-flash** | 284B MoE (13B activated) preview for efficient reasoning across a massive context | 🧠 | 1M | 87K |
| **deepseek-v4-pro** | Frontier MoE with three reasoning modes across a 1M-token context | 🧠 | 1M | 75K |

> **Capability Legend:** 🧠 Thinking · 👁 Vision · 🎧 Audio · (all support 🛠 Tools & ☁️ Cloud)

---

## 🔑 Key Highlights

### 🏆 Most Popular
- **Qwen 3.5** (12.4M pulls) and **Gemma 4** (10.3M pulls) lead by a wide margin — both are multimodal families with broad appeal.

### 🧠 Reasoning & Thinking
- **12 out of 20** models support a dedicated *thinking/reasoning* mode, including all DeepSeek, GLM, MiniMax, Nemotron, Gemini, and Kimi variants.
- **DeepSeek-V4-Pro** uniquely offers **three reasoning modes** for flexible cognitive control.

### 👁 Multimodal (Vision)
- **7 models** support vision: Gemma 4, Qwen 3.5, Gemini 3 Flash, Kimi K2.5/K2.6, Devstral Small 2 — and **Gemma 4** is the only one to also support **audio**.

### 📏 Context Window extremes
| Metric | Model | Size |
|---|---|---|
| **Largest** | DeepSeek-V4-Flash / Pro, Gemini 3 Flash, Nemotron-3-Nano | **1M tokens** |
| **Smallest** | Rnj-1 | **32K tokens** |

### 🏗️ Mixture-of-Experts (MoE)
- **DeepSeek-V4-Flash** — 284B total, only 13B activated (95.4% sparse)
- **GLM-5** — 744B total, 40B activated (94.6% sparse)
- **Nemotron-3-Super** — 120B total, 12B activated (90% sparse)

### 💻 Coding Specialists
- **Devstral Small 2** (24B) & **Devstral 2** (123B) — purpose-built for agentic codebase exploration.
- **Qwen3-Coder-Next** — coding-focused with 256K context.
- **GLM-5.1** — SOTA on SWE-Bench Pro.

### 🆚 Head-to-Head: Kimi K2.5 vs K2.6
| | K2.5 | K2.6 |
|---|---|---|
| Pulls | 296K | 262K |
| Focus | Vision-language integration, instant & thinking modes | Long-horizon coding, swarm orchestration |
| Context | 256K | 256K |
| Capabilities | 🧠 👁 🛠 | 🧠 👁 🛠 |

---

*Data reflects community pull counts as of the current snapshot. All models are cloud-hosted and require an active cloud connection.*