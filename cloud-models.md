# ☁️ Cloud Model Directory

A comprehensive overview of the latest cloud-hosted models available on Ollama, sorted by popularity.

---

## Model Catalog

| Model | Description | Capabilities | Context | Pulls |
|---|---|---|---|---|
| **gemma4** | Frontier-level performance at each size; excels at reasoning, agentic workflows, coding & multimodal understanding | 🎥 Vision · 🔧 Tools · 🧠 Thinking · 🔊 Audio | 128K | 10.3M |
| **qwen3.5** | Open-source multimodal family delivering exceptional utility and performance | 🎥 Vision · 🔧 Tools · 🧠 Thinking | 256K | 12.4M |
| **nemotron-3-super** | 120B open MoE activating just 12B params for max compute efficiency in complex multi-agent apps | 🔧 Tools · 🧠 Thinking | 256K | 2.4M |
| **glm-5** | 744B total / 40B active MoE for complex systems engineering & long-horizon tasks | 🔧 Tools · 🧠 Thinking | 202.8K | 2.3M |
| **deepseek-v3.2** | Harmonizes high computational efficiency with superior reasoning & agent performance | 🔧 Tools · 🧠 Thinking | 160K | 2.2M |
| **glm-5.1** | Next-gen flagship for agentic engineering; SOTA on SWE-Bench Pro, leads GLM-5 by a wide margin | 🔧 Tools · 🧠 Thinking | 198K | 2.2M |
| **minimax-m2.7** | M2-series model for coding, agentic workflows & professional productivity | 🔧 Tools · 🧠 Thinking | 200K | 2.2M |
| **minimax-m2.5** | SOTA large language model designed for real-world productivity & coding tasks | 🔧 Tools · 🧠 Thinking | 198K | 2.2M |
| **glm-4.7** | Advancing the coding capability | 🔧 Tools · 🧠 Thinking | 198K | 2.2M |
| **gemini-3-flash-preview** | Frontier intelligence built for speed at a fraction of the cost | 🎥 Vision · 🔧 Tools · 🧠 Thinking | 1M | 2.2M |
| **minimax-m2.1** | Exceptional multilingual capabilities to elevate code engineering | 🔧 Tools | 200K | 2.1M |
| **qwen3-coder-next** | Coding-focused model from Alibaba's Qwen team, optimized for agentic coding workflows & local dev | 🔧 Tools | 256K | 1.3M |
| **devstral-small-2** | 24B model excelling at tool-driven codebase exploration, multi-file editing & powering SE agents | 🎥 Vision · 🔧 Tools | 384K | 840.4K |
| **rnj-1** | 8B dense model family trained from scratch by Essential AI, optimized for code & STEM | 🔧 Tools | 32K | 467.4K |
| **nemotron-3-nano** | New standard for efficient, open & intelligent agentic models — now a 4B parameter model | 🔧 Tools · 🧠 Thinking | 1M | 455K |
| **kimi-k2.5** | Native multimodal agentic model with vision+language, instant & thinking modes | 🎥 Vision · 🔧 Tools · 🧠 Thinking | 256K | 295.5K |
| **kimi-k2.6** | Native multimodal agentic model advancing long-horizon coding, design, autonomous execution & swarm orchestration | 🎥 Vision · 🔧 Tools · 🧠 Thinking | 256K | 261.9K |
| **devstral-2** | 123B model excelling at tool-driven codebase exploration, multi-file editing & powering SE agents | 🔧 Tools | 256K | 224.4K |
| **deepseek-v4-flash** | MoE with 284B total / 13B activated for efficient reasoning across a massive context | 🔧 Tools · 🧠 Thinking | 1M | 86.4K |
| **deepseek-v4-pro** | Frontier MoE with 1M context and three reasoning modes | 🔧 Tools · 🧠 Thinking | 1M | 75.4K |

---

## 🏆 Key Highlights

### Most Popular
- **qwen3.5** leads with **12.4M pulls**, followed by **gemma4** at **10.3M** — both multimodal powerhouses.

### 🎥 Multimodal (Vision) Models
Six models support vision input: **gemma4**, **qwen3.5**, **kimi-k2.5**, **kimi-k2.6**, **devstral-small-2**, and **gemini-3-flash-preview**.

### 🧠 Built-in Thinking / Reasoning
The majority of models (15 of 20) support a *thinking* mode for extended reasoning. Notably, **deepseek-v4-pro** offers **three distinct reasoning modes**.

### 🔊 Audio Capabilities
Only **gemma4** currently supports audio input alongside vision, tools, and thinking — making it the most versatile model in the catalog.

### 📏 Long-Context Leaders
Four models support a **1M-token context window**:
- **deepseek-v4-flash**
- **deepseek-v4-pro**
- **gemini-3-flash-preview**
- **nemotron-3-nano**

The largest non-1M context goes to **devstral-small-2** at **384K tokens**.

### ⚡ MoE Efficiency Champions
| Model | Total Params | Active Params | Activation Ratio |
|---|---|---|---|
| deepseek-v4-flash | 284B | 13B | ~4.6% |
| glm-5 | 744B | 40B | ~5.4% |
| nemotron-3-super | 120B | 12B | ~10% |

These Mixture-of-Experts models activate only a fraction of their total parameters during inference, delivering strong performance at significantly lower compute cost.

### 💻 Coding & Agentic Specialists
Several models are purpose-built for software engineering and agentic workflows:
- **qwen3-coder-next** — coding-first, agentic workflows & local dev
- **devstral-small-2** & **devstral-2** — tool-driven codebase exploration & multi-file editing
- **glm-5.1** — SOTA on SWE-Bench Pro for agentic engineering
- **kimi-k2.6** — swarm-based task orchestration & autonomous execution

### 🪶 Lightweight Options
For resource-constrained environments, consider:
- **rnj-1** — 8B dense model, 32K context, strong code/STEM performance
- **nemotron-3-nano** — 4B params with a massive 1M context window

---

> *Data reflects cloud model availability on Ollama. Pull counts are approximate and continually growing.*