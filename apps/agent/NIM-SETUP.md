# Nemotron NIM setup (research 2026-11-07; limited time, items marked UNVERIFIED)

## 1. Hosted: integrate.api.nvidia.com/v1
- Base URL: `https://integrate.api.nvidia.com/v1` (OpenAI-compatible) - https://build.nvidia.com/nvidia/nemotron-3-nano-30b-a3b
- Get key: sign in at build.nvidia.com (free NVIDIA developer account) -> open any model page -> "Get API Key" / "Build with this NIM" -> Generate. Key starts `nvapi-`. Free tier is rate-limited (~40 RPM, UNVERIFIED). Put in `NVIDIA_API_KEY` env.

| Model id (`model`) | Tools | Reasoning toggle | Context | Source |
|---|---|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b` (120B MoE, 12B active) | yes | `chat_template_kwargs: {enable_thinking:false}` (default on); `low_effort:true` for less thinking | up to 1M | https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b ; https://docs.nvidia.com/nim/large-language-models/2.0.4/turbo/get-started-nemotron-3-super-120b-a12b.html |
| `nvidia/nemotron-3-nano-30b-a3b` (30B, 3.5B active) - hosted id string UNVERIFIED (HF id is `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`); confirm via `GET /v1/models` | yes (trained on tool-call data) | `enable_thinking=false` via chat_template_kwargs | 262k default | https://build.nvidia.com/nvidia/nemotron-3-nano-30b-a3b |
| `nvidia/llama-3.3-nemotron-super-49b-v1.5` | UNVERIFIED (not checked) | system prompt `/no_think` style, UNVERIFIED | 128k UNVERIFIED | not fetched |

Recommendation (judgement, not benchmarked):
- PRIMARY: `nvidia/nemotron-3-super-120b-a12b` - best agentic/tool quality; 12B active so reasonably fast. Use temperature 1.0, top_p 0.95 (NVIDIA guidance, build.nvidia.com page above). For speed in a multi-step loop send `enable_thinking:false` (or `low_effort:true`).
- FALLBACK: `nvidia/nemotron-3-nano-30b-a3b` (3B active = lowest latency).
- Check live ids/tool support in 10s: `curl -s https://integrate.api.nvidia.com/v1/models -H "Authorization: Bearer $NVIDIA_API_KEY" | grep -i nemotron`
- If tool calls come back empty/garbled on hosted, try the fallback before debugging.
- Role `function` is not supported; return results with role `tool` (NIM doc above).

## 2. Brev self-hosted NIM
Facts: Brev (NVIDIA) offers GPU instances with Docker + NVIDIA drivers preinstalled, "Launchables" (one-click environments) and NIM deployment - https://docs.nvidia.com/brev/latest/ . Specific Brev pricing, credit redemption flow, CLI port commands and NIM-launchable catalog were NOT confirmed (docs page /nim.html 404). Treat those as UNVERIFIED; check brev.nvidia.com console.

Steps:
1. Sign up at brev.nvidia.com; redeem hackathon credits in Billing/Credits (promo code from organizers; UNVERIFIED UI path).
2. NGC key: ngc.nvidia.com -> Setup -> API Keys -> Generate Personal Key with "NGC Catalog" service (or use an `nvapi-` key from build.nvidia.com if accepted, UNVERIFIED). https://docs.nvidia.com/nim/large-language-models/2.0.4/turbo/get-started-nemotron-3-super-120b-a12b.html
3. Create GPU instance (Create Instance, or a NIM launchable if one exists for Nemotron). GPU sizing (UNVERIFIED, estimates): Nano 30B-A3B BF16 ~60GB weights -> 1x H100 80GB / A100 80GB (~$2-4/hr) ; Super 120B -> multi-GPU H100 80GB (several GPUs, NIM Turbo supports a limited GPU set per its Support Matrix - check it first). Super is costly; prefer hosted API for Super and self-host only Nano.
4. On the instance:
```
export NGC_API_KEY=<key>
echo "$NGC_API_KEY" | docker login nvcr.io --username '$oauthtoken' --password-stdin
mkdir -p ~/.cache/nim && export LOCAL_NIM_CACHE=~/.cache/nim
docker run -d --gpus=all --shm-size=16g -e NGC_API_KEY=$NGC_API_KEY \
  -v "$LOCAL_NIM_CACHE:/opt/nim/.cache" -p 8000:8000 \
  nvcr.io/nim/nvidia/nemotron-3-super-120b-a12b-turbo:1.0.0
```
   (image verified for Super Turbo only, same doc. Nano image name UNVERIFIED: likely `nvcr.io/nim/nvidia/nemotron-3-nano-30b-a3b:<tag>`; look it up on build.nvidia.com -> model -> Deploy tab.) First start downloads weights (many minutes). Wait for `curl localhost:8000/v1/health/ready`.
5. Reach from laptop: expose port 8000 in the Brev instance's "Access"/ports panel (public URL) or tunnel over SSH: `ssh -L 8000:localhost:8000 <brev-host>` (Brev CLI `brev port-forward <instance> -p 8000:8000` exists per Brev docs, UNVERIFIED here). Then `baseURL=http://localhost:8000/v1`, apiKey any string. If publicly exposed, front it with a secret; NIM has no auth by default.
- Tool-calling flags: the Super NIM doc says tool calling is "enabled" and points to a "Tool Calling and MCP Integration" page; no env flag was stated. Older LLM NIMs used `NIM_ENABLE_AUTO_TOOL_CHOICE=1` + `NIM_TOOL_CALL_PARSER=<parser>` - UNVERIFIED for these models; if tool_calls are empty, set those.
- Served model name on NIM: check `curl localhost:8000/v1/models`.

## 3. Minimal tool call (hosted)
curl:
```
curl -s https://integrate.api.nvidia.com/v1/chat/completions \
 -H "Authorization: Bearer $NVIDIA_API_KEY" -H "Content-Type: application/json" -d '{
 "model":"nvidia/nemotron-3-super-120b-a12b",
 "messages":[{"role":"user","content":"Weather in Austin?"}],
 "tools":[{"type":"function","function":{"name":"get_weather","description":"Get weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],
 "tool_choice":"auto","temperature":1.0,"top_p":0.95,"max_tokens":1024,
 "chat_template_kwargs":{"enable_thinking":false}}'
```
openai Node:
```ts
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "https://integrate.api.nvidia.com/v1", apiKey: process.env.NVIDIA_API_KEY });
const res = await client.chat.completions.create({
  model: "nvidia/nemotron-3-super-120b-a12b",
  messages: [{ role: "user", content: "Weather in Austin?" }],
  tools: [{ type: "function", function: { name: "get_weather", description: "Get weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
  tool_choice: "auto", temperature: 1.0, top_p: 0.95, max_tokens: 1024,
  // @ts-expect-error NVIDIA extension
  chat_template_kwargs: { enable_thinking: false },
});
console.log(res.choices[0].message.tool_calls);
// loop: push assistant msg, then {role:"tool", tool_call_id, content} and call again
```
Note: whether hosted accepts top-level `chat_template_kwargs` vs `extra_body` is UNVERIFIED; the openai Node SDK passes unknown top-level body keys through as shown. These snippets were not executed.
