import { HardwareSpecs, HuggingFaceModelEntry } from "../types/agent";

export interface CatalogModelEntry {
  id: string;
  install_id: string;
  name: string;
  author: string;
  source: "ollama" | "huggingface";
  params: string;
  size_gb: number;
  min_ram_gb: number;
  recommended_vram_gb: number;
  is_coding: boolean;
  is_uncensored: boolean;
  is_reasoning: boolean;
  is_fast_subagent: boolean;
  summary: string;
  downloads?: number;
  likes?: number;
}

export interface HardwareFitVerdict {
  tier: "gpu_fast" | "ram_compatible" | "tight_fit" | "too_heavy";
  canRun: boolean;
  label: string;
  detail: string;
}

export function evaluateModelHardwareFit(
  model: Pick<
    CatalogModelEntry,
    "size_gb" | "min_ram_gb" | "recommended_vram_gb" | "params"
  >,
  hw: HardwareSpecs | null
): HardwareFitVerdict {
  if (!hw) {
    return {
      tier: "ram_compatible",
      canRun: true,
      label: "✓ Ready to Install",
      detail: `Requires ~${model.min_ram_gb} GB RAM`,
    };
  }

  const totalRam = hw.total_ram_gb || 16;
  const vram = hw.gpu_vram_gb || 0;

  // 1. Fits directly inside dedicated GPU VRAM
  if (vram > 0 && vram >= model.recommended_vram_gb) {
    return {
      tier: "gpu_fast",
      canRun: true,
      label: "⚡ Runs Fast on GPU",
      detail: `Fits in ${hw.gpu_name} (${vram}GB VRAM ≥ ${model.recommended_vram_gb}GB needed)`,
    };
  }

  // 2. Comfortably fits in system RAM (or unified GPU/CPU memory)
  if (totalRam >= model.min_ram_gb * 1.15) {
    return {
      tier: vram === 0 && totalRam >= model.recommended_vram_gb * 1.5 ? "gpu_fast" : "ram_compatible",
      canRun: true,
      label: "✓ Compatible with Your PC",
      detail: `Needs ${model.min_ram_gb}GB RAM • Your PC has ${totalRam}GB RAM`,
    };
  }

  // 3. Barely fits in total system RAM
  if (totalRam >= model.min_ram_gb * 0.9) {
    return {
      tier: "tight_fit",
      canRun: true,
      label: "⚠ Tight RAM Fit (Slower)",
      detail: `Needs ~${model.min_ram_gb}GB RAM • Close to your ${totalRam}GB limit`,
    };
  }

  // 4. Exceeds PC hardware capacity
  return {
    tier: "too_heavy",
    canRun: false,
    label: `⛔ Too Heavy (${model.min_ram_gb}GB RAM req)`,
    detail: `Requires ${model.min_ram_gb}GB RAM / ${model.recommended_vram_gb}GB VRAM (Your PC: ${totalRam}GB RAM)`,
  };
}

export function hfEntryToCatalogEntry(
  hf: HuggingFaceModelEntry
): CatalogModelEntry {
  return {
    id: hf.install_id,
    install_id: hf.install_id,
    name: hf.name,
    author: hf.author,
    source: "huggingface",
    params: hf.params,
    size_gb: hf.size_gb,
    min_ram_gb: hf.min_ram_gb,
    recommended_vram_gb: hf.recommended_vram_gb,
    is_coding: hf.is_coding,
    is_uncensored: hf.is_uncensored,
    is_reasoning: hf.is_reasoning,
    is_fast_subagent: hf.is_fast_subagent,
    summary: hf.summary,
    downloads: hf.downloads,
    likes: hf.likes,
  };
}

export const CURATED_MODEL_CATALOG: CatalogModelEntry[] = [
  // ==================== CODING + UNCENSORED (ABLITERATED) ====================
  {
    id: "hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF",
    install_id: "hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-abliterated-GGUF",
    name: "Qwen 2.5 Coder 7B (Uncensored / Abliterated)",
    author: "bartowski (HuggingFace GGUF)",
    source: "huggingface",
    params: "7B",
    size_gb: 4.7,
    min_ram_gb: 8,
    recommended_vram_gb: 6,
    is_coding: true,
    is_uncensored: true,
    is_reasoning: false,
    is_fast_subagent: true,
    summary:
      "Uncensored & refusal-abliterated Qwen 2.5 Coder 7B. Built for autonomous coding, security auditing, reverse engineering, and unrestricted tool execution.",
  },
  {
    id: "hf.co/bartowski/Qwen2.5-Coder-14B-Instruct-abliterated-GGUF",
    install_id: "hf.co/bartowski/Qwen2.5-Coder-14B-Instruct-abliterated-GGUF",
    name: "Qwen 2.5 Coder 14B (Uncensored / Abliterated)",
    author: "bartowski (HuggingFace GGUF)",
    source: "huggingface",
    params: "14B",
    size_gb: 9.0,
    min_ram_gb: 16,
    recommended_vram_gb: 10,
    is_coding: true,
    is_uncensored: true,
    is_reasoning: false,
    is_fast_subagent: false,
    summary:
      "High-intelligence 14B Uncensored Lead Architect for complex multi-file coding, reverse engineering, binary analysis, and red-team research.",
  },
  {
    id: "hf.co/huihui-ai/DeepSeek-R1-Distill-Qwen-7B-abliterated-GGUF",
    install_id: "hf.co/huihui-ai/DeepSeek-R1-Distill-Qwen-7B-abliterated-GGUF",
    name: "DeepSeek-R1 7B (Uncensored + Reasoning)",
    author: "huihui-ai (HuggingFace GGUF)",
    source: "huggingface",
    params: "7B",
    size_gb: 4.7,
    min_ram_gb: 8,
    recommended_vram_gb: 6,
    is_coding: true,
    is_uncensored: true,
    is_reasoning: true,
    is_fast_subagent: true,
    summary:
      "Refusal-abliterated DeepSeek-R1 7B with full chain-of-thought <think> reasoning and unrestricted coding & security capabilities.",
  },
  {
    id: "hf.co/huihui-ai/DeepSeek-R1-Distill-Qwen-14B-abliterated-GGUF",
    install_id: "hf.co/huihui-ai/DeepSeek-R1-Distill-Qwen-14B-abliterated-GGUF",
    name: "DeepSeek-R1 14B (Uncensored + Reasoning)",
    author: "huihui-ai (HuggingFace GGUF)",
    source: "huggingface",
    params: "14B",
    size_gb: 9.0,
    min_ram_gb: 16,
    recommended_vram_gb: 10,
    is_coding: true,
    is_uncensored: true,
    is_reasoning: true,
    is_fast_subagent: false,
    summary:
      "Uncensored 14B DeepSeek-R1 Lead Architect combining deep step-by-step reasoning with zero alignment refusals.",
  },

  // ==================== CODING & AGENTIC SPECIALISTS ====================
  {
    id: "qwen2.5-coder:1.5b",
    install_id: "qwen2.5-coder:1.5b",
    name: "Qwen 2.5 Coder 1.5B (Ultra-Fast Subagent)",
    author: "Ollama Official",
    source: "ollama",
    params: "1.5B",
    size_gb: 1.0,
    min_ram_gb: 4,
    recommended_vram_gb: 2,
    is_coding: true,
    is_uncensored: false,
    is_reasoning: false,
    is_fast_subagent: true,
    summary:
      "Featherweight coding model that runs effortlessly on any PC. Ideal for fast parallel Subagents doing file searches and quick edits.",
  },
  {
    id: "qwen2.5-coder:3b",
    install_id: "qwen2.5-coder:3b",
    name: "Qwen 2.5 Coder 3B (Fast Subagent)",
    author: "Ollama Official",
    source: "ollama",
    params: "3B",
    size_gb: 2.0,
    min_ram_gb: 6,
    recommended_vram_gb: 3.5,
    is_coding: true,
    is_uncensored: false,
    is_reasoning: false,
    is_fast_subagent: true,
    summary:
      "Best balance of speed and coding accuracy for Subagent workers on 8GB–16GB RAM PCs.",
  },
  {
    id: "qwen2.5-coder:7b",
    install_id: "qwen2.5-coder:7b",
    name: "Qwen 2.5 Coder 7B (Recommended Coding Agent)",
    author: "Ollama Official",
    source: "ollama",
    params: "7B",
    size_gb: 4.7,
    min_ram_gb: 8,
    recommended_vram_gb: 6,
    is_coding: true,
    is_uncensored: false,
    is_reasoning: false,
    is_fast_subagent: true,
    summary:
      "Top-rated 7B local coding agent for TypeScript, Rust, Python, C++, terminal execution, and autonomous repository workflows.",
  },
  {
    id: "qwen2.5-coder:14b",
    install_id: "qwen2.5-coder:14b",
    name: "Qwen 2.5 Coder 14B (Pro Lead Architect)",
    author: "Ollama Official",
    source: "ollama",
    params: "14B",
    size_gb: 9.0,
    min_ram_gb: 16,
    recommended_vram_gb: 10,
    is_coding: true,
    is_uncensored: false,
    is_reasoning: false,
    is_fast_subagent: false,
    summary:
      "Near GPT-4o coding performance locally. Ideal as Lead Architect directing smaller 3B/7B subagents.",
  },
  {
    id: "qwen2.5-coder:32b",
    install_id: "qwen2.5-coder:32b",
    name: "Qwen 2.5 Coder 32B (Workstation Flagship)",
    author: "Ollama Official",
    source: "ollama",
    params: "32B",
    size_gb: 19.5,
    min_ram_gb: 32,
    recommended_vram_gb: 20,
    is_coding: true,
    is_uncensored: false,
    is_reasoning: false,
    is_fast_subagent: false,
    summary:
      "Flagship 32B local software engineering model for high-RAM / 24GB VRAM workstations.",
  },
  {
    id: "deepseek-coder-v2:16b",
    install_id: "deepseek-coder-v2:16b",
    name: "DeepSeek Coder V2 16B Lite (MoE)",
    author: "Ollama Official",
    source: "ollama",
    params: "16B",
    size_gb: 8.9,
    min_ram_gb: 14,
    recommended_vram_gb: 10,
    is_coding: true,
    is_uncensored: false,
    is_reasoning: false,
    is_fast_subagent: false,
    summary:
      "Mixture-of-Experts coding model with ultra-fast token generation and deep systems programming knowledge (C++, Rust, Assembly).",
  },

  // ==================== UNCENSORED / UNFILTERED GENERAL & AGENT MODELS ====================
  {
    id: "dolphin-mistral:7b",
    install_id: "dolphin-mistral:7b",
    name: "Dolphin 2.8 Mistral 7B (Uncensored)",
    author: "Cognitive Computations",
    source: "ollama",
    params: "7B",
    size_gb: 4.1,
    min_ram_gb: 8,
    recommended_vram_gb: 5.5,
    is_coding: true,
    is_uncensored: true,
    is_reasoning: false,
    is_fast_subagent: true,
    summary:
      "Eric Hartford's famous uncensored Dolphin model trained on coding, function calling, and unfiltered instruction datasets.",
  },
  {
    id: "dolphin-llama3:8b",
    install_id: "dolphin-llama3:8b",
    name: "Dolphin 2.9 Llama-3 8B (Uncensored)",
    author: "Cognitive Computations",
    source: "ollama",
    params: "8B",
    size_gb: 4.7,
    min_ram_gb: 8,
    recommended_vram_gb: 6,
    is_coding: true,
    is_uncensored: true,
    is_reasoning: false,
    is_fast_subagent: true,
    summary:
      "Uncensored Llama-3 8B tuned for compliance, agentic tool use, coding, and zero preachy alignment refusals.",
  },
  {
    id: "hermes3:8b",
    install_id: "hermes3:8b",
    name: "Nous Hermes 3 Llama-3.1 8B (Uncensored Agent)",
    author: "Nous Research",
    source: "ollama",
    params: "8B",
    size_gb: 4.7,
    min_ram_gb: 8,
    recommended_vram_gb: 6,
    is_coding: true,
    is_uncensored: true,
    is_reasoning: false,
    is_fast_subagent: true,
    summary:
      "Unfiltered, steerable agentic model by Nous Research with native JSON function calling and code generation.",
  },
  {
    id: "wizard-vicuna-uncensored:7b",
    install_id: "wizard-vicuna-uncensored:7b",
    name: "Wizard Vicuna Uncensored 7B",
    author: "Ollama Library",
    source: "ollama",
    params: "7B",
    size_gb: 3.8,
    min_ram_gb: 8,
    recommended_vram_gb: 5,
    is_coding: false,
    is_uncensored: true,
    is_reasoning: false,
    is_fast_subagent: true,
    summary:
      "Classic completely uncensored 7B model with all alignment guardrails stripped for security and research workflows.",
  },
  {
    id: "hf.co/failspy/Meta-Llama-3-8B-Instruct-abliterated-v3-GGUF",
    install_id: "hf.co/failspy/Meta-Llama-3-8B-Instruct-abliterated-v3-GGUF",
    name: "Llama-3 8B Instruct Abliterated v3",
    author: "failspy (HuggingFace GGUF)",
    source: "huggingface",
    params: "8B",
    size_gb: 4.7,
    min_ram_gb: 8,
    recommended_vram_gb: 6,
    is_coding: false,
    is_uncensored: true,
    is_reasoning: false,
    is_fast_subagent: true,
    summary:
      "Weight-orthogonalized Llama-3 8B that removes refusal directions without losing intelligence or instruction accuracy.",
  },

  // ==================== REASONING / DEEPTHINK MODELS ====================
  {
    id: "deepseek-r1:1.5b",
    install_id: "deepseek-r1:1.5b",
    name: "DeepSeek-R1 1.5B (Fast Reasoning)",
    author: "Ollama Official",
    source: "ollama",
    params: "1.5B",
    size_gb: 1.1,
    min_ram_gb: 4,
    recommended_vram_gb: 2,
    is_coding: true,
    is_uncensored: false,
    is_reasoning: true,
    is_fast_subagent: true,
    summary:
      "Compact chain-of-thought reasoning model that streams visible <think> traces on any PC.",
  },
  {
    id: "deepseek-r1:7b",
    install_id: "deepseek-r1:7b",
    name: "DeepSeek-R1 7B (Reasoning + Coding)",
    author: "Ollama Official",
    source: "ollama",
    params: "7B",
    size_gb: 4.7,
    min_ram_gb: 8,
    recommended_vram_gb: 6,
    is_coding: true,
    is_uncensored: false,
    is_reasoning: true,
    is_fast_subagent: false,
    summary:
      "Distilled Qwen-7B reasoning model that plans complex multi-step architecture and shows live thought traces in Oxide.",
  },
  {
    id: "deepseek-r1:14b",
    install_id: "deepseek-r1:14b",
    name: "DeepSeek-R1 14B (Lead Reasoning Architect)",
    author: "Ollama Official",
    source: "ollama",
    params: "14B",
    size_gb: 9.0,
    min_ram_gb: 16,
    recommended_vram_gb: 10,
    is_coding: true,
    is_uncensored: false,
    is_reasoning: true,
    is_fast_subagent: false,
    summary:
      "Deep reasoning Lead Architect for hard debugging, math, reverse-engineering, and multi-subagent planning.",
  },
];
