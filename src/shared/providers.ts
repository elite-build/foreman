// API-key environment variables OpenCode understands (from models.dev), for
// Settings → Agents → OpenCode → Providers.

export interface ProviderKeyInfo {
  envVar: string
  label: string
  keyUrl?: string
  popular?: boolean
}

const KNOWN: ProviderKeyInfo[] = [
  { envVar: 'OPENCODE_API_KEY', label: 'OpenCode Zen', keyUrl: 'https://opencode.ai/auth', popular: true },
  { envVar: 'ANTHROPIC_API_KEY', label: 'Anthropic', keyUrl: 'https://console.anthropic.com/settings/keys', popular: true },
  { envVar: 'OPENAI_API_KEY', label: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys', popular: true },
  { envVar: 'OPENROUTER_API_KEY', label: 'OpenRouter', keyUrl: 'https://openrouter.ai/keys', popular: true },
  { envVar: 'GOOGLE_API_KEY', label: 'Google AI Studio', keyUrl: 'https://aistudio.google.com/apikey', popular: true },
  { envVar: 'GITHUB_TOKEN', label: 'GitHub Copilot / GitHub Models', keyUrl: 'https://github.com/settings/tokens', popular: true },
  { envVar: 'AI_GATEWAY_API_KEY', label: 'Vercel AI Gateway', keyUrl: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys', popular: true },
  { envVar: 'GROQ_API_KEY', label: 'Groq', keyUrl: 'https://console.groq.com/keys' },
  { envVar: 'MISTRAL_API_KEY', label: 'Mistral', keyUrl: 'https://console.mistral.ai/api-keys' },
  { envVar: 'XAI_API_KEY', label: 'xAI', keyUrl: 'https://console.x.ai' },
  { envVar: 'DEEPSEEK_API_KEY', label: 'DeepSeek', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { envVar: 'PERPLEXITY_API_KEY', label: 'Perplexity', keyUrl: 'https://www.perplexity.ai/settings/api' },
  { envVar: 'TOGETHER_API_KEY', label: 'Together AI', keyUrl: 'https://api.together.ai/settings/api-keys' },
  { envVar: 'FIREWORKS_API_KEY', label: 'Fireworks AI', keyUrl: 'https://fireworks.ai/account/api-keys' },
  { envVar: 'CEREBRAS_API_KEY', label: 'Cerebras', keyUrl: 'https://cloud.cerebras.ai' },
  { envVar: 'HF_TOKEN', label: 'Hugging Face', keyUrl: 'https://huggingface.co/settings/tokens' },
  { envVar: 'DEEPINFRA_API_KEY', label: 'DeepInfra' },
  { envVar: 'MOONSHOT_API_KEY', label: 'Moonshot AI' },
  { envVar: 'ZHIPU_API_KEY', label: 'Zhipu AI' },
  { envVar: 'AWS_BEARER_TOKEN_BEDROCK', label: 'Amazon Bedrock' },
  { envVar: 'GITLAB_TOKEN', label: 'GitLab Duo' },
  { envVar: 'OLLAMA_API_KEY', label: 'Ollama Cloud' },
  { envVar: 'LMSTUDIO_API_KEY', label: 'LM Studio' },
  { envVar: 'NVIDIA_API_KEY', label: 'NVIDIA' },
  { envVar: 'COHERE_API_KEY', label: 'Cohere' },
  { envVar: 'DASHSCOPE_API_KEY', label: 'Alibaba DashScope' },
  { envVar: 'MINIMAX_API_KEY', label: 'MiniMax' },
  { envVar: 'KIMI_API_KEY', label: 'Kimi' },
  { envVar: 'VENICE_API_KEY', label: 'Venice AI' },
  { envVar: 'NEBIUS_API_KEY', label: 'Nebius' },
  { envVar: 'SCALEWAY_API_KEY', label: 'Scaleway' },
  { envVar: 'OVHCLOUD_API_KEY', label: 'OVHcloud' },
  { envVar: 'BASETEN_API_KEY', label: 'Baseten' },
  { envVar: 'CHUTES_API_KEY', label: 'Chutes' },
  { envVar: 'REQUESTY_API_KEY', label: 'Requesty' },
  { envVar: 'HELICONE_API_KEY', label: 'Helicone' },
  { envVar: 'SILICONFLOW_API_KEY', label: 'SiliconFlow' },
  { envVar: 'V0_API_KEY', label: 'v0' },
  { envVar: 'WANDB_API_KEY', label: 'Weights & Biases' }
]

// The rest of OpenCode's catalog; labels are derived from the name.
const OTHERS = [
  '302AI_API_KEY', 'ABACUS_API_KEY', 'ABLIT_KEY', 'AICORE_SERVICE_KEY', 'AIHUBMIX_API_KEY', 'ALIBABA_CODING_PLAN_API_KEY',
  'BAILING_API_TOKEN', 'BERGET_API_KEY', 'CLARIFAI_PAT', 'CLOUDFERRO_SHERLOCK_API_KEY', 'CORTECS_API_KEY',
  'DIGITALOCEAN_ACCESS_TOKEN', 'DINFERENCE_API_KEY', 'DRUN_API_KEY', 'EVROC_API_KEY', 'FASTROUTER_API_KEY', 'FIREPASS_API_KEY',
  'FRIENDLI_TOKEN', 'FROGBOT_API_KEY', 'HPC_AI_API_KEY', 'IFLOW_API_KEY', 'INCEPTION_API_KEY', 'INFERENCE_API_KEY',
  'IOINTELLIGENCE_API_KEY', 'JIEKOU_API_KEY', 'KILO_API_KEY', 'KUAE_API_KEY', 'LLAMA_API_KEY', 'LLMGATEWAY_API_KEY',
  'LUCIDQUERY_API_KEY', 'MEGANOVA_API_KEY', 'MIXLAYER_API_KEY', 'MOARK_API_KEY', 'MODELSCOPE_API_KEY', 'MORPH_API_KEY',
  'NANO_GPT_API_KEY', 'NEURALWATT_API_KEY', 'NOVA_API_KEY', 'NOVITA_API_KEY', 'POE_API_KEY', 'QIHANG_API_KEY', 'QINIU_API_KEY',
  'REGOLO_API_KEY', 'SARVAM_API_KEY', 'SILICONFLOW_CN_API_KEY', 'STACKIT_API_KEY', 'STEPFUN_API_KEY',
  'SUBMODEL_INSTAGEN_ACCESS_KEY', 'SYNTHETIC_API_KEY', 'TENCENT_CODING_PLAN_API_KEY', 'TENCENT_TOKENHUB_API_KEY',
  'THEGRIDAI_API_KEY', 'UPSTAGE_API_KEY', 'VIVGRID_API_KEY', 'VULTR_API_KEY', 'WAFER_API_KEY', 'XIAOMI_API_KEY',
  'ZENMUX_API_KEY'
]

function labelFor(envVar: string): string {
  const stem = envVar.replace(/_(API_KEY|API_TOKEN|ACCESS_TOKEN|ACCESS_KEY|SERVICE_KEY|TOKEN|KEY|PAT)$/, '')
  return stem
    .split('_')
    .map((w) => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase()))
    .join(' ')
}

export const PROVIDER_KEYS: ProviderKeyInfo[] = [...KNOWN, ...OTHERS.map((envVar) => ({ envVar, label: labelFor(envVar) }))]

export function providerInfo(envVar: string): ProviderKeyInfo {
  return PROVIDER_KEYS.find((p) => p.envVar === envVar) ?? { envVar, label: labelFor(envVar) }
}
